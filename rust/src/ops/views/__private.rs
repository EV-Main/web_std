//! What `#[derive(Views)]`'s code calls.

use schemars::{JsonSchema, SchemaGenerator, generate::SchemaSettings};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use super::{
	At, Error,
	table::{Entry, Table, canonical, object, props, sampled, shape},
};

pub struct Builder {
	generator: SchemaGenerator,
	table: Table,
}

impl Builder {
	pub fn empty() -> Self {
		Self {
			generator: SchemaSettings::draft2020_12()
				.with(|s| {
					s.inline_subschemas = true;
					s.meta_schema = None;
				})
				.into_generator(),
			table: Table {
				carried: object(Map::new()).expect("no properties is an object schema"),
				views: Default::default(),
			},
		}
	}

	/// `T` takes and gives back a sampled value of its schema: the one is the other's.
	pub fn carried<T: JsonSchema + Serialize + DeserializeOwned>(&mut self) {
		let root = self.generator.root_schema_for::<T>().to_value();
		let properties = root["properties"]
			.as_object()
			.unwrap_or_else(|| panic!("carried {}: a struct, its fields the keys", T::schema_name()));
		let properties = properties
			.iter()
			.map(|(k, s)| canonical(s.clone()).map(|s| (k.clone(), s)).unwrap_or_else(|e| panic!("carried ?{k}: {e}")))
			.collect();
		self.table.carried = object(properties).unwrap_or_else(|e| panic!("carried: {e}"));
		let sample = Value::Object(sampled(&self.table.carried).unwrap_or_else(|e| panic!("carried: {e}")));
		let taken: T = serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("carried {}: {sample} is no value of it: {e}", T::schema_name()));
		assert_eq!(value(&taken), sample, "carried {}: its schema is not how it serializes", T::schema_name());
	}

	pub fn schema<T: JsonSchema>(&mut self, doc: &str) -> Result<Value, String> {
		let mut schema = canonical(self.generator.subschema_for::<T>().to_value())?;
		if !doc.is_empty() {
			schema["description"] = doc.into();
		}
		Ok(schema)
	}

	#[expect(clippy::too_many_arguments, reason = "one per attribute of a view, the derive's call")]
	pub fn view(
		&mut self,
		name: &str,
		path: &str,
		description: &str,
		needs: Option<&str>,
		key: Option<char>,
		params: Vec<(&str, Result<Value, String>)>,
		query: Vec<(&str, Result<Value, String>)>,
	) {
		let entry = Entry {
			path: path.into(),
			description: description.into(),
			params: fields(name, params),
			query: fields(name, query),
			needs: needs.map(str::to_owned),
			key,
			nest: None,
			scope: None,
		};
		assert!(self.table.views.insert(name.into(), entry).is_none(), "{name} is a view already");
	}

	pub fn nest(&mut self, name: &str, path: &str, needs: Option<&str>, params: Vec<(&str, Result<Value, String>)>, inner: &Table) {
		let outer = props(&fields(name, params)).clone();
		self.table.merge(name, path, outer, needs, inner.clone(), true).unwrap_or_else(|e| panic!("{e}"));
	}

	#[expect(clippy::too_many_arguments, reason = "one per attribute of a view, the derive's call")]
	pub fn foreign(
		&mut self,
		name: &str,
		path: &str,
		description: &str,
		service: &str,
		needs: Option<&str>,
		key: Option<char>,
		scope: Option<char>,
		mut params: Vec<(&str, Result<Value, String>)>,
	) {
		params.push(("below", Ok(json!({ "type": "string" }))));
		let entry = Entry {
			path: path.into(),
			description: description.into(),
			params: fields(name, params),
			query: object(Map::new()).expect("no properties is an object schema"),
			needs: needs.map(str::to_owned),
			key,
			nest: Some(service.into()),
			scope,
		};
		assert!(self.table.views.insert(name.into(), entry).is_none(), "{name} is a view already");
	}

	/// The table, checked: `ty` names the enum in what fails.
	pub fn build(self, ty: &str) -> Table {
		self.table.check().unwrap_or_else(|e| panic!("{ty}: {e}"));
		self.table
	}
}

fn fields(view: &str, fields: Vec<(&str, Result<Value, String>)>) -> Value {
	let properties = fields.into_iter().map(|(k, s)| (k.to_owned(), s.unwrap_or_else(|e| panic!("{view}: {k}: {e}")))).collect();
	object(properties).unwrap_or_else(|e| panic!("{view}: {e}"))
}

pub fn value<T: Serialize>(v: &T) -> Value {
	serde_json::to_value(v).expect("a view's field serializes to JSON")
}

pub fn at(view: &str, params: Vec<(&str, Value)>) -> At {
	At {
		view: view.into(),
		params: params.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
	}
}

pub fn nested(view: &str, inner: At, params: Vec<(&str, Value)>) -> At {
	let mut at = at(&format!("{view}.{}", inner.view), params);
	at.params.extend(inner.params);
	at
}

/// A view's params as `from_at` takes them apart, an absent one as it is absent.
pub struct Fields {
	view: String,
	params: Map<String, Value>,
}

impl Fields {
	pub fn new(table: &Table, at: At) -> Result<(String, Self), Error> {
		let entry = table.views.get(&at.view).ok_or_else(|| Error(format!("no view is named {:?}", at.view)))?;
		let mut params = at.params;
		for (k, s) in props(&entry.params).iter().chain(props(&entry.query)) {
			if !params.contains_key(k)
				&& let Some(absent) = shape(s).expect("a table's schemas are checked on build").absent()
			{
				params.insert(k.clone(), absent);
			}
		}
		Ok((at.view.clone(), Self { view: at.view, params }))
	}

	pub fn take<T: DeserializeOwned>(&mut self, key: &str) -> Result<T, Error> {
		let v = self.params.remove(key).ok_or_else(|| Error(format!("{}: {key} is missing", self.view)))?;
		serde_json::from_value(v).map_err(|e| Error(format!("{}: {key}: {e}", self.view)))
	}

	pub fn done(self) -> Result<(), Error> {
		match self.params.keys().next() {
			Some(k) => Err(Error(format!("{}: it has no param {k}", self.view))),
			None => Ok(()),
		}
	}

	/// What is left, as the nested view's.
	pub fn rest(self, view: &str) -> At {
		At {
			view: view.into(),
			params: self.params,
		}
	}
}

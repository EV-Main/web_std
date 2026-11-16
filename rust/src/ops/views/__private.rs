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

fn generator() -> SchemaGenerator {
	SchemaSettings::draft2020_12()
		.with(|s| {
			s.inline_subschemas = true;
			s.meta_schema = None;
		})
		.into_generator()
}

impl Builder {
	pub fn empty() -> Self {
		Self {
			generator: generator(),
			table: Table {
				carried: object(Map::new()).expect("no properties is an object schema"),
				views: Default::default(),
			},
		}
	}

	pub fn carried<T: JsonSchema + Serialize + DeserializeOwned>(&mut self) {
		self.table.carried = object(self.keys::<T>("carried")).unwrap_or_else(|e| panic!("carried: {e}"));
	}

	/// A flattened field's query keys, as serde flattens it.
	pub fn flattened<T: JsonSchema + Serialize + DeserializeOwned>(&mut self) -> Vec<(String, Result<Value, String>)> {
		self.keys::<T>("a flattened field").into_iter().map(|(k, s)| (k, Ok(s))).collect()
	}

	/// A struct's fields, each a key. `T` takes and gives back a sampled value of its schema: the one
	/// is the other's.
	fn keys<T: JsonSchema + Serialize + DeserializeOwned>(&mut self, what: &str) -> Map<String, Value> {
		let ty = T::schema_name();
		let root = self.generator.root_schema_for::<T>().to_value();
		let properties: Map<String, Value> = root["properties"]
			.as_object()
			.unwrap_or_else(|| panic!("{what} {ty}: a struct, its fields the keys"))
			.iter()
			.map(|(k, s)| canonical(s.clone()).map(|s| (k.clone(), s)).unwrap_or_else(|e| panic!("{what} {ty}: ?{k}: {e}")))
			.collect();
		let schema = object(properties.clone()).unwrap_or_else(|e| panic!("{what} {ty}: {e}"));
		let sample = Value::Object(sampled(&schema).unwrap_or_else(|e| panic!("{what} {ty}: {e}")));
		let taken: T = serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{what} {ty}: {sample} is no value of it: {e}"));
		assert_eq!(value(&taken), sample, "{what} {ty}: its schema is not how it serializes");
		properties
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
		params: Vec<(String, Result<Value, String>)>,
		query: Vec<(String, Result<Value, String>)>,
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

	pub fn nest(&mut self, name: &str, path: &str, needs: Option<&str>, params: Vec<(String, Result<Value, String>)>, inner: &Table) {
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
		mut params: Vec<(String, Result<Value, String>)>,
	) {
		params.push(("below".into(), Ok(json!({ "type": "string" }))));
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

fn fields(view: &str, fields: Vec<(String, Result<Value, String>)>) -> Value {
	let mut properties = Map::new();
	for (k, s) in fields {
		let s = s.unwrap_or_else(|e| panic!("{view}: {k}: {e}"));
		assert!(properties.insert(k.clone(), s).is_none(), "{view}: ?{k} is two fields' key");
	}
	object(properties).unwrap_or_else(|e| panic!("{view}: {e}"))
}

pub fn value<T: Serialize>(v: &T) -> Value {
	serde_json::to_value(v).expect("a view's field serializes to JSON")
}

pub fn at(view: &str, params: Vec<(String, Value)>) -> At {
	let mut at = At {
		view: view.into(),
		params: Map::new(),
	};
	for (k, v) in params {
		assert!(at.params.insert(k.clone(), v).is_none(), "{view}: ?{k} is two fields' key");
	}
	at
}

/// A flattened field's keys and values.
pub fn spread<T: Serialize>(v: &T) -> Vec<(String, Value)> {
	match value(v) {
		Value::Object(o) => o.into_iter().collect(),
		v => panic!("a flattened field serializes as a struct, not as {v}"),
	}
}

pub fn nested(view: &str, inner: At, params: Vec<(String, Value)>) -> At {
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

	/// A flattened field, from the keys its struct has.
	pub fn flattened<T: JsonSchema + DeserializeOwned>(&mut self) -> Result<T, Error> {
		let root = generator().root_schema_for::<T>().to_value();
		let keys = root["properties"].as_object().expect("a flattened field's schema is checked on build");
		let taken: Map<String, Value> = keys.keys().filter_map(|k| self.params.remove(k).map(|v| (k.clone(), v))).collect();
		serde_json::from_value(Value::Object(taken)).map_err(|e| Error(format!("{}: {e}", self.view)))
	}

	/// What is left, as the nested view's.
	pub fn rest(self, view: &str) -> At {
		At {
			view: view.into(),
			params: self.params,
		}
	}
}

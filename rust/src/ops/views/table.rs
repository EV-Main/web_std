//! The table (`x-views`) and its one codec, which `ts/views` mirrors (`tests/fixtures/views/`).

use std::{
	borrow::Cow,
	collections::{BTreeMap, BTreeSet},
};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};

use super::{At, Error};

/// `encodeURIComponent`'s: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
pub(super) const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
	.remove(b'-')
	.remove(b'_')
	.remove(b'.')
	.remove(b'!')
	.remove(b'~')
	.remove(b'*')
	.remove(b'\'')
	.remove(b'(')
	.remove(b')');

/// A service's views, by name: the document's `x-views`, and what `href`/`parse` read.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
	/// The query keys beside every view, which the page keeps across its moves.
	pub(super) carried: Value,
	pub(super) views: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
	pub(super) path: String,
	pub(super) description: String,
	pub(super) params: Value,
	pub(super) query: Value,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(super) needs: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(super) key: Option<char>,
	/// The service whose table goes under this one: everything below it is `below`'s.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(super) nest: Option<String>,
	/// The key that opens the nested service's own keys.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(super) scope: Option<char>,
}

impl Table {
	/// `at`'s href, `carried` beside it. Its query is sorted by key.
	pub fn href(&self, at: &At, carried: &Map<String, Value>) -> Result<String, Error> {
		let fail = |why: String| Error(format!("{}: {why}", at.view));
		let entry = self.views.get(&at.view).ok_or_else(|| Error(format!("no view is named {:?}", at.view)))?;
		let (params, query, kept) = (props(&entry.params), props(&entry.query), props(&self.carried));
		if let Some(k) = at.params.keys().find(|k| !params.contains_key(*k) && !query.contains_key(*k)) {
			return Err(fail(format!("it has no param {k}")));
		}
		let mut out = String::new();
		for seg in segments(&entry.path) {
			out.push('/');
			match seg {
				Seg::Static(s) => out.push_str(s),
				Seg::Param(p) => {
					let v = at.params.get(p).ok_or_else(|| fail(format!("{p} is missing")))?;
					let text = encode(&shape(&params[p]).map_err(&fail)?, v)
						.map_err(|e| fail(format!("{p}: {e}")))?
						.expect("a path param has no absent form");
					out.extend(utf8_percent_encode(&text, SEGMENT));
				}
			}
		}
		let mut pairs = BTreeMap::new();
		for (k, schema) in query {
			let s = shape(schema).map_err(&fail)?;
			match at.params.get(k) {
				Some(v) =>
					if let Some(text) = encode(&s, v).map_err(|e| fail(format!("{k}: {e}")))? {
						pairs.insert(k.clone(), text);
					},
				None if s.absent().is_none() => return Err(fail(format!("{k} is missing"))),
				None => {}
			}
		}
		for (k, v) in carried {
			let schema = kept.get(k).ok_or_else(|| fail(format!("{k} is carried by no view")))?;
			if let Some(text) = encode(&shape(schema).map_err(&fail)?, v).map_err(|e| fail(format!("{k}: {e}")))? {
				pairs.insert(k.clone(), text);
			}
		}
		if entry.nest.is_some() {
			let below = at
				.params
				.get("below")
				.and_then(Value::as_str)
				.ok_or_else(|| fail("below is a string, the href under it".into()))?;
			let (path, query) = below.split_once('?').unwrap_or((below, ""));
			if !path.is_empty() && !path.starts_with('/') {
				return Err(fail(format!("below {below:?} starts with / or ?")));
			}
			out.push_str(path);
			for (k, v) in form_urlencoded::parse(query.as_bytes()) {
				if pairs.insert(k.to_string(), v.into_owned()).is_some() {
					return Err(fail(format!("below's ?{k} is a key of this table's")));
				}
			}
		}
		if out.is_empty() {
			out.push('/');
		}
		if !pairs.is_empty() {
			out.push('?');
			out.push_str(&form_urlencoded::Serializer::new(String::new()).extend_pairs(&pairs).finish());
		}
		Ok(out)
	}

	/// The view `href` is, and the carried keys beside it. An absent key is absent from the params.
	pub fn parse(&self, href: &str) -> Result<(At, Map<String, Value>), Error> {
		let fail = |why: String| Error(format!("{href}: {why}"));
		if href.contains('#') {
			return Err(fail("a view has no fragment".into()));
		}
		let (path, query) = href.split_once('?').unwrap_or((href, ""));
		let rest = path.strip_prefix('/').ok_or_else(|| fail("an href starts with /".into()))?;
		let rest = rest.strip_suffix('/').filter(|r| !r.is_empty()).unwrap_or(rest); // a static export serves `/sites/` for `/sites`
		let raw: Vec<&str> = if rest.is_empty() { vec![] } else { rest.split('/').collect() };
		if raw.iter().any(|s| s.is_empty()) {
			return Err(fail("an empty segment".into()));
		}
		let decoded = raw
			.iter()
			.map(|s| percent_decode_str(s).decode_utf8().map(Cow::into_owned))
			.collect::<Result<Vec<_>, _>>()
			.map_err(|e| fail(e.to_string()))?;

		let mut best: Option<(Vec<u8>, &String, &Entry)> = None;
		for (name, entry) in &self.views {
			let t = segments(&entry.path);
			let marker = entry.nest.is_some();
			if (marker && decoded.len() < t.len()) || (!marker && decoded.len() != t.len()) {
				continue;
			}
			if t.iter().zip(&decoded).any(|(s, d)| matches!(s, Seg::Static(x) if x != d)) {
				continue;
			}
			// Position by position: a static segment beats a param, a param a nest's rest.
			let mut rank: Vec<u8> = (0..decoded.len())
				.map(|i| match t.get(i) {
					Some(Seg::Static(_)) => 0,
					Some(Seg::Param(_)) => 1,
					None => 2,
				})
				.collect();
			rank.push(if marker { 2 } else { 0 });
			if best.as_ref().is_none_or(|(r, ..)| rank < *r) {
				best = Some((rank, name, entry));
			}
		}
		let (_, name, entry) = best.ok_or_else(|| fail("no view has this path".into()))?;
		let fail = |why: String| Error(format!("{href}: {name}: {why}"));

		let (params_schema, query_schema, kept) = (props(&entry.params), props(&entry.query), props(&self.carried));
		let mut params = Map::new();
		let t = segments(&entry.path);
		for (seg, d) in t.iter().zip(&decoded) {
			if let Seg::Param(p) = seg {
				params.insert((*p).to_owned(), decode(&shape(&params_schema[*p]).map_err(&fail)?, d).map_err(|e| fail(format!("{p}: {e}")))?);
			}
		}
		let (mut carried, mut passed, mut seen) = (Map::new(), Vec::new(), BTreeSet::new());
		for (k, v) in form_urlencoded::parse(query.as_bytes()) {
			if !seen.insert(k.clone()) {
				return Err(fail(format!("?{k} is given twice")));
			}
			if let Some(s) = query_schema.get(&*k) {
				params.insert(k.to_string(), decode(&shape(s).map_err(&fail)?, &v).map_err(|e| fail(format!("{k}: {e}")))?);
			} else if let Some(s) = kept.get(&*k) {
				carried.insert(k.to_string(), decode(&shape(s).map_err(&fail)?, &v).map_err(|e| fail(format!("{k}: {e}")))?);
			} else if entry.nest.is_some() {
				passed.push((k, v));
			} else {
				return Err(fail(format!("?{k} is no key of it")));
			}
		}
		for (k, s) in query_schema {
			if !params.contains_key(k) && shape(s).map_err(&fail)?.absent().is_none() {
				return Err(fail(format!("?{k} is missing")));
			}
		}
		if entry.nest.is_some() {
			let mut below: String = raw[t.len()..].iter().map(|s| format!("/{s}")).collect();
			if !passed.is_empty() {
				below.push('?');
				below.push_str(&form_urlencoded::Serializer::new(String::new()).extend_pairs(passed).finish());
			}
			params.insert("below".into(), Value::String(below));
		}
		Ok((At { view: name.clone(), params }, carried))
	}

	/// `theirs` under the view that nests `service` (`nest = "<service>"`), its views named
	/// `<that view>.<theirs>`. Their keys stay theirs: they are bound in that service's scope.
	pub fn nest(&mut self, service: &str, theirs: Table) -> Result<(), Error> {
		let markers: Vec<&String> = self.views.iter().filter(|(_, e)| e.nest.as_deref() == Some(service)).map(|(n, _)| n).collect();
		let [marker] = markers[..] else {
			return Err(Error(format!("{} views nest {service}, not one", markers.len())));
		};
		let marker = marker.clone();
		let entry = &self.views[&marker];
		let (path, mut outer) = (entry.path.clone(), props(&entry.params).clone());
		outer.remove("below");
		// The marker's needs open the host's page; the nested views keep the needs their service gave them.
		self.merge(&marker, &path, outer, None, theirs, false).map_err(Error)?;
		self.check().map_err(Error)
	}

	/// `theirs` under `path`, its views named `<name>.<theirs>`, `outer` the path's params, `needs` what
	/// opens every one of them: a view opens on one permission, so one of theirs naming its own is refused.
	pub(super) fn merge(&mut self, name: &str, path: &str, outer: Map<String, Value>, needs: Option<&str>, theirs: Table, keep_keys: bool) -> Result<(), String> {
		for (n, e) in theirs.views {
			let full = format!("{name}.{n}");
			let mut params = outer.clone();
			for (k, v) in props(&e.params) {
				if params.insert(k.clone(), v.clone()).is_some() {
					return Err(format!("{full}: {k} is a param of the nest's and of the view's"));
				}
			}
			let params = object(params)?;
			let needs = match (needs, e.needs) {
				(Some(n), Some(m)) => return Err(format!("{full}: a view opens on one permission, and its nest names {n}, it {m}")),
				(n, m) => n.map(str::to_owned).or(m),
			};
			let entry = Entry {
				path: joined(path, &e.path),
				key: e.key.filter(|_| keep_keys && fills_nothing(&params, &e.query)),
				description: e.description,
				params,
				query: e.query,
				needs,
				nest: e.nest,
				scope: e.scope,
			};
			if self.views.insert(full.clone(), entry).is_some() {
				return Err(format!("{full} is a view already"));
			}
		}
		let mut carried = props(&self.carried).clone();
		for (k, v) in props(&theirs.carried) {
			if carried.insert(k.clone(), v.clone()).is_some() {
				return Err(format!("{name}: ?{k} is carried twice"));
			}
		}
		self.carried = object(carried)?;
		Ok(())
	}

	#[cfg(feature = "views_dioxus")]
	pub(super) fn has_no_query(&self) -> bool {
		props(&self.carried).is_empty() && self.views.values().all(|e| props(&e.query).is_empty())
	}

	/// Every rule a table holds, and a sampled round trip of every view.
	pub(super) fn check(&self) -> Result<(), String> {
		let kept = props(&self.carried);
		for (k, s) in kept {
			shape(s).map_err(|e| format!("carried ?{k}: {e}"))?;
		}
		let (mut shapes, mut keys) = (BTreeMap::new(), BTreeMap::new());
		for (name, e) in &self.views {
			let at = |why: String| format!("{name}: {why}");
			let marker = e.nest.is_some();
			if !(e.path.starts_with('/') || (marker && e.path.is_empty())) || (e.path.len() > 1 && e.path.ends_with('/')) {
				return Err(at(format!("{:?} is no path", e.path)));
			}
			let t = segments(&e.path);
			let (params, query) = (props(&e.params), props(&e.query));
			let mut named: BTreeSet<&str> = t
				.iter()
				.filter_map(|s| match s {
					Seg::Param(p) => Some(*p),
					Seg::Static("") => Some(""),
					Seg::Static(_) => None,
				})
				.collect();
			if named.contains("") {
				return Err(at("an empty segment".into()));
			}
			for p in &named {
				let s = params.get(*p).ok_or_else(|| at(format!("{{{p}}} has no schema")))?;
				let s = shape(s).map_err(|why| at(format!("{p}: {why}")))?;
				if s.nullable || !matches!(s.form, Form::Scalar(_)) {
					return Err(at(format!("{p}: a path param is a string, a number or a word")));
				}
			}
			if marker {
				if e.query != object(Map::new())? {
					return Err(at("a nest's query is its nested views'".into()));
				}
				if params.get("below") != Some(&json!({ "type": "string" })) {
					return Err(at("a nest's below is a string".into()));
				}
				named.insert("below");
			}
			if params.keys().map(String::as_str).collect::<BTreeSet<_>>() != named {
				return Err(at("its params are its path's".into()));
			}
			for (k, s) in query {
				shape(s).map_err(|why| at(format!("?{k}: {why}")))?;
				if params.contains_key(k) {
					return Err(at(format!("{k} is a param and a query key")));
				}
			}
			if let Some(k) = query.keys().find(|k| kept.contains_key(*k)) {
				return Err(at(format!("?{k} is carried beside every view")));
			}
			let shape_of = (t.iter().map(|s| if let Seg::Static(s) = s { (*s).to_owned() } else { "{}".into() }).collect::<Vec<_>>(), marker);
			if let Some(other) = shapes.insert(shape_of, name) {
				return Err(at(format!("{other}'s path is the same")));
			}
			if let Some(c) = e.key {
				if let Some(other) = keys.insert(c, name) {
					return Err(at(format!("'{c}' is {other}'s key")));
				}
				if !fills_nothing(&e.params, &e.query) {
					return Err(at(format!("'{c}' opens a view with nothing to fill; this one has")));
				}
			}

			let mut params = sampled(&e.params)?;
			params.extend(sampled(&e.query)?);
			if marker {
				params.insert("below".into(), Value::String("/s0".into()));
			}
			let sample = At { view: name.clone(), params };
			let carried = sampled(&self.carried)?;
			let href = self.href(&sample, &carried).map_err(|e| at(e.0))?;
			let back = self.parse(&href).map_err(|e| at(e.0))?;
			if back != (sample.clone(), carried.clone()) {
				return Err(at(format!("{href} parses as {back:?}, not as {sample:?}")));
			}
		}
		Ok(())
	}
}

/// Whether a view opens with no value given: a key's view.
fn fills_nothing(params: &Value, query: &Value) -> bool {
	let required = |o: &Value| o["required"].as_array().expect("an object schema lists its required").iter().filter(|k| *k != "below").count();
	required(params) == 0 && required(query) == 0
}

fn joined(outer: &str, inner: &str) -> String {
	match (outer, inner) {
		("", "/") => "/".into(),
		(o, "/") => o.into(),
		(o, i) => format!("{o}{i}"),
	}
}

enum Seg<'a> {
	Static(&'a str),
	Param(&'a str),
}

fn segments(path: &str) -> Vec<Seg<'_>> {
	match path {
		"" | "/" => vec![],
		p => p[1..]
			.split('/')
			.map(|s| match s.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
				Some(p) => Seg::Param(p),
				None => Seg::Static(s),
			})
			.collect(),
	}
}

/// An object schema's properties.
pub(super) fn props(object: &Value) -> &Map<String, Value> {
	object["properties"].as_object().expect("a table's params, query and carried are object schemas")
}

/// The object schema of `properties`, each canonical: required is what has no absent form.
pub(super) fn object(properties: Map<String, Value>) -> Result<Value, String> {
	let mut required = Vec::new();
	for (k, s) in &properties {
		if shape(s).map_err(|e| format!("{k}: {e}"))?.absent().is_none() {
			required.push(Value::String(k.clone()));
		}
	}
	Ok(json!({ "type": "object", "properties": properties, "required": required }))
}

/// schemars' schema of a field, in the one form the codec reads: `Option`'s `anyOf` folded into a
/// nullable `type`, a documented enum's `oneOf` into its `enum`.
pub(super) fn canonical(schema: Value) -> Result<Value, String> {
	let Value::Object(mut o) = schema else {
		return Err("a field's type has no schema of its own (`true`)".into());
	};
	o.remove("$schema");
	o.remove("title");
	if let Some(any) = o.remove("anyOf") {
		let any = any.as_array().ok_or("anyOf is an array")?;
		let null = json!({ "type": "null" });
		let [inner] = &any.iter().filter(|s| **s != null).collect::<Vec<_>>()[..] else {
			return Err("an anyOf other than an Option's has no URL form".into());
		};
		if any.len() != 2 {
			return Err("an anyOf other than an Option's has no URL form".into());
		}
		let mut inner = canonical((*inner).clone())?;
		let io = inner.as_object_mut().expect("canonical schemas are objects");
		match io.get_mut("type") {
			Some(t @ Value::String(_)) => *t = json!([t.clone(), "null"]),
			_ => return Err("an Option of an Option has no URL form".into()),
		}
		if let Some(Value::Array(words)) = io.get_mut("enum") {
			words.push(Value::Null);
		}
		if let Some(d) = o.remove("description") {
			io.insert("description".into(), d);
		}
		shape(&inner)?;
		return Ok(inner);
	}
	if let Some(one) = o.remove("oneOf") {
		// schemars gives a documented word its own `const`, and the undocumented ones one `enum`.
		let words = one
			.as_array()
			.ok_or("oneOf is an array")?
			.iter()
			.map(|v| match (v.get("const"), v.get("enum")) {
				(Some(c @ Value::String(_)), None) => Some(vec![c.clone()]),
				(None, Some(Value::Array(e))) if e.iter().all(Value::is_string) => Some(e.clone()),
				_ => None,
			})
			.collect::<Option<Vec<_>>>()
			.ok_or("a oneOf other than an enum's words has no URL form")?
			.concat();
		o.insert("type".into(), "string".into());
		o.insert("enum".into(), Value::Array(words));
	}
	for key in ["items"] {
		if let Some(v) = o.remove(key) {
			o.insert(key.into(), canonical(v)?);
		}
	}
	if let Some(Value::Array(items)) = o.remove("prefixItems") {
		o.insert("prefixItems".into(), Value::Array(items.into_iter().map(canonical).collect::<Result<_, _>>()?));
	}
	let mut schema = Value::Object(o);
	if shape(&schema)?.form == Form::Json {
		required_listed(&mut schema);
	}
	Ok(schema)
}

/// Every object in a JSON value lists its `required`, `[]` too (schemars leaves an empty one out), so a
/// client types its members by it.
fn required_listed(schema: &mut Value) {
	let Value::Object(o) = schema else { return };
	if o.contains_key("properties") && !o.contains_key("required") {
		o.insert("required".into(), json!([]));
	}
	if let Some(Value::Object(members)) = o.get_mut("properties") {
		members.values_mut().for_each(required_listed);
	}
	for key in ["additionalProperties", "items"] {
		if let Some(v) = o.get_mut(key) {
			required_listed(v);
		}
	}
	for key in ["prefixItems", "anyOf", "oneOf"] {
		if let Some(Value::Array(vs)) = o.get_mut(key) {
			vs.iter_mut().for_each(required_listed);
		}
	}
}

#[derive(Clone, Debug, PartialEq)]
enum Scalar {
	Text(Option<Vec<String>>),
	Int,
	Num,
}

#[derive(Clone, Debug, PartialEq)]
enum Form {
	Scalar(Scalar),
	/// Present with no value, or absent.
	Flag,
	List(Scalar),
	Tuple(Vec<Scalar>),
	/// Its JSON text.
	Json,
}

pub(super) struct Shape {
	form: Form,
	nullable: bool,
}

impl Shape {
	/// What an absent key means; `None` when it must be there.
	pub(super) fn absent(&self) -> Option<Value> {
		match (&self.form, self.nullable) {
			(_, true) => Some(Value::Null),
			(Form::Flag, _) => Some(Value::Bool(false)),
			(Form::List(_), _) => Some(Value::Array(vec![])),
			_ => None,
		}
	}
}

pub(super) fn shape(schema: &Value) -> Result<Shape, String> {
	let o = schema.as_object().ok_or("a schema is an object")?;
	let (base, nullable) = match o.get("type") {
		Some(Value::String(t)) => (t.as_str(), false),
		Some(Value::Array(ts)) => match &ts[..] {
			[Value::String(t), Value::String(n)] if n == "null" => (t.as_str(), true),
			_ => return Err(format!("type {ts:?} has no URL form")),
		},
		_ => return Err("a URL value has a type".into()),
	};
	let form = match base {
		"boolean" if nullable => return Err("an Option<bool> has no URL form: an absent flag is false already".into()),
		"boolean" => Form::Flag,
		"array" => match (o.get("prefixItems"), o.get("items")) {
			(Some(Value::Array(items)), _) => Form::Tuple(items.iter().map(scalar).collect::<Result<_, _>>()?),
			(None, Some(item)) => Form::List(scalar(item)?),
			_ => return Err("an array has items".into()),
		},
		"object" => Form::Json,
		_ => Form::Scalar(scalar_of(base, o)?),
	};
	Ok(Shape { form, nullable })
}

fn scalar(schema: &Value) -> Result<Scalar, String> {
	let o = schema.as_object().ok_or("a schema is an object")?;
	match o.get("type") {
		Some(Value::String(t)) => scalar_of(t, o),
		_ => Err("a list's or a tuple's items are strings, numbers or words".into()),
	}
}

fn scalar_of(base: &str, o: &Map<String, Value>) -> Result<Scalar, String> {
	match base {
		"string" => Ok(Scalar::Text(match o.get("enum") {
			Some(Value::Array(words)) => {
				let words: Vec<String> = words.iter().filter_map(|w| w.as_str().map(str::to_owned)).collect();
				if words.is_empty() {
					return Err("an enum has words".into());
				}
				Some(words)
			}
			_ => None,
		})),
		"integer" => Ok(Scalar::Int),
		"number" => Ok(Scalar::Num),
		t => Err(format!("a {t} has no URL form")),
	}
}

/// `None`: absent from the URL.
fn encode(shape: &Shape, v: &Value) -> Result<Option<String>, String> {
	if v.is_null() {
		return if shape.nullable { Ok(None) } else { Err("null is no value of it".into()) };
	}
	Ok(match &shape.form {
		Form::Flag => match v {
			Value::Bool(true) => Some(String::new()),
			Value::Bool(false) => None,
			_ => return Err(format!("{v} is no flag")),
		},
		Form::Scalar(s) => Some(text(s, v)?),
		Form::List(s) => {
			let items = v.as_array().ok_or_else(|| format!("{v} is no list"))?;
			if items.is_empty() && !shape.nullable {
				None
			} else {
				Some(joined_texts(items.iter().map(|i| (s, i)))?)
			}
		}
		Form::Tuple(ss) => {
			let items = v.as_array().filter(|a| a.len() == ss.len()).ok_or_else(|| format!("{v} is no {}-tuple", ss.len()))?;
			Some(joined_texts(ss.iter().zip(items))?)
		}
		Form::Json => Some(sorted(v).to_string()),
	})
}

/// Object keys sorted, whatever order serde_json keeps (`preserve_order`): one text per value.
fn sorted(v: &Value) -> Value {
	match v {
		Value::Object(o) => {
			let mut keys: Vec<&String> = o.keys().collect();
			keys.sort();
			Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&o[k]))).collect())
		}
		Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
		v => v.clone(),
	}
}

fn joined_texts<'a>(items: impl Iterator<Item = (&'a Scalar, &'a Value)>) -> Result<String, String> {
	let texts = items.map(|(s, v)| text(s, v)).collect::<Result<Vec<_>, _>>()?;
	if let Some(t) = texts.iter().find(|t| t.contains(',')) {
		return Err(format!("{t:?}: an item of a list has no comma"));
	}
	Ok(texts.join(","))
}

fn text(s: &Scalar, v: &Value) -> Result<String, String> {
	match (s, v) {
		(Scalar::Text(words), Value::String(t)) => {
			if let Some(words) = words
				&& !words.contains(t)
			{
				return Err(format!("{t:?} is none of {words:?}"));
			}
			Ok(t.clone())
		}
		(Scalar::Int, Value::Number(n)) if n.is_i64() || n.is_u64() => Ok(n.to_string()),
		(Scalar::Num, Value::Number(n)) => {
			let x = n.as_f64().expect("a JSON number is an f64");
			// As JS writes a number: a whole one has no `.0`.
			Ok(if x.fract() == 0.0 && x.abs() < 1e15 { format!("{}", x as i64) } else { format!("{x}") })
		}
		_ => Err(format!("{v} is no {s:?}")),
	}
}

fn decode(shape: &Shape, t: &str) -> Result<Value, String> {
	Ok(match &shape.form {
		Form::Flag if t.is_empty() => Value::Bool(true),
		Form::Flag => return Err(format!("{t:?}: a flag is there with no value")),
		Form::Scalar(s) => value(s, t)?,
		Form::List(_) if t.is_empty() && shape.nullable => Value::Array(vec![]),
		Form::List(_) if t.is_empty() => return Err("an empty list is no key at all".into()),
		Form::List(s) => Value::Array(t.split(',').map(|i| value(s, i)).collect::<Result<_, _>>()?),
		Form::Tuple(ss) => {
			let items: Vec<&str> = t.split(',').collect();
			if items.len() != ss.len() {
				return Err(format!("{t:?} is no {}-tuple", ss.len()));
			}
			Value::Array(ss.iter().zip(items).map(|(s, i)| value(s, i)).collect::<Result<_, _>>()?)
		}
		Form::Json => serde_json::from_str(t).map_err(|e| format!("{t:?}: {e}"))?,
	})
}

fn value(s: &Scalar, t: &str) -> Result<Value, String> {
	match s {
		Scalar::Text(words) => {
			if let Some(words) = words
				&& !words.iter().any(|w| w == t)
			{
				return Err(format!("{t:?} is none of {words:?}"));
			}
			Ok(Value::String(t.to_owned()))
		}
		Scalar::Int if integer(t) => t
			.parse::<i64>()
			.map(Number::from)
			.or_else(|_| t.parse::<u64>().map(Number::from))
			.map(Value::Number)
			.map_err(|e| format!("{t:?}: {e}")),
		Scalar::Num if number(t) => t
			.parse::<f64>()
			.ok()
			.and_then(Number::from_f64)
			.map(Value::Number)
			.ok_or_else(|| format!("{t:?} is no finite number")),
		Scalar::Int | Scalar::Num => Err(format!("{t:?} is no {s:?}")),
	}
}

/// `-?(0|[1-9][0-9]*)`: one text per integer, as JS and Rust both write it.
fn integer(t: &str) -> bool {
	let d = t.strip_prefix('-').unwrap_or(t);
	d == "0" || (d.starts_with(|c: char| ('1'..='9').contains(&c)) && d.bytes().all(|b| b.is_ascii_digit()))
}

/// An integer, then `.digits`, then `e[+-]digits`, each but the first optional.
fn number(t: &str) -> bool {
	let (mantissa, exp) = t.split_once(['e', 'E']).map_or((t, None), |(m, e)| (m, Some(e)));
	let (whole, frac) = mantissa.split_once('.').map_or((mantissa, None), |(w, f)| (w, Some(f)));
	let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
	integer(whole) && frac.is_none_or(digits) && exp.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)))
}

/// A value of each of an object schema's properties.
pub(super) fn sampled(object: &Value) -> Result<Map<String, Value>, String> {
	props(object).iter().map(|(k, s)| Ok((k.clone(), sample(s, &shape(s)?)))).collect()
}

/// A value of `schema`: its first `examples` where it names one (a type a pattern or a check
/// narrows), a date for a `format` of one, else a text with a space in it.
fn sample(schema: &Value, shape: &Shape) -> Value {
	fn scalar(schema: &Value, s: &Scalar) -> Value {
		if let Some(example) = schema.get("examples").and_then(|e| e.get(0)) {
			return example.clone();
		}
		match s {
			Scalar::Text(Some(words)) => Value::String(words[0].clone()),
			Scalar::Text(None) => match schema.get("format").and_then(Value::as_str) {
				Some("date") => json!("2026-01-31"),
				Some("date-time") => json!("2026-01-31T10:00:00Z"),
				_ => Value::String("s 0".into()),
			},
			Scalar::Int => json!(7),
			Scalar::Num => json!(0.5),
		}
	}
	match &shape.form {
		Form::Flag => Value::Bool(true),
		Form::Scalar(s) => scalar(schema, s),
		Form::List(s) => json!([scalar(&schema["items"], s), scalar(&schema["items"], s)]),
		Form::Tuple(ss) => Value::Array(ss.iter().zip(schema["prefixItems"].as_array().into_iter().flatten()).map(|(s, item)| scalar(item, s)).collect()),
		Form::Json => json!({}),
	}
}

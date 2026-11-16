//! ev_lib's derives. `Views` is documented on the trait it implements, `ev_lib::views::Views`.

use std::collections::{BTreeMap, BTreeSet};

use proc_macro::TokenStream;
use proc_macro2::TokenStream as Tokens;
use quote::quote;
use syn::{Attribute, Data, DeriveInput, Error, Expr, ExprLit, Fields, Ident, Lit, LitChar, LitStr, Meta, Result, Token, Type, parse::ParseStream};

#[proc_macro_derive(Views, attributes(view, views))]
pub fn views(input: TokenStream) -> TokenStream {
	derive(syn::parse_macro_input!(input as DeriveInput)).unwrap_or_else(Error::into_compile_error).into()
}

enum Kind {
	Plain,
	/// Another enum of this crate's, its views under the prefix.
	Nest,
	/// Another service's table, merged by whoever holds both (`Table::nest`).
	Foreign {
		service: LitStr,
		scope: Option<LitChar>,
	},
}

struct ViewAttr {
	path: LitStr,
	needs: Option<Expr>,
	key: Option<LitChar>,
	kind: Kind,
}

fn view_attr(attr: &Attribute) -> Result<ViewAttr> {
	attr.parse_args_with(|input: ParseStream| {
		let path: LitStr = input.parse()?;
		let (mut needs, mut key, mut nest, mut service, mut scope) = (None, None, false, None, None);
		let mut seen = BTreeSet::new();
		while !input.is_empty() {
			input.parse::<Token![,]>()?;
			if input.is_empty() {
				break;
			}
			let name: Ident = input.parse()?;
			if !seen.insert(name.to_string()) {
				return Err(Error::new(name.span(), format!("`{name}` is given twice")));
			}
			match name.to_string().as_str() {
				"needs" => {
					input.parse::<Token![=]>()?;
					needs = Some(input.parse::<Expr>()?);
				}
				"key" => {
					input.parse::<Token![=]>()?;
					key = Some(input.parse::<LitChar>()?);
				}
				"scope" => {
					input.parse::<Token![=]>()?;
					scope = Some(input.parse::<LitChar>()?);
				}
				"nest" => {
					nest = true;
					if input.peek(Token![=]) {
						input.parse::<Token![=]>()?;
						service = Some(input.parse::<LitStr>()?);
					}
				}
				_ => return Err(Error::new(name.span(), "a view takes `needs`, `key`, `nest` and `scope`")),
			}
		}
		let kind = match (nest, service) {
			(false, _) => Kind::Plain,
			(true, None) => Kind::Nest,
			(true, Some(service)) => Kind::Foreign { service, scope: scope.take() },
		};
		if let Some(scope) = scope {
			return Err(Error::new(
				scope.span(),
				"`scope` is the letter of another service's views: only a `nest = \"<service>\"` has one",
			));
		}
		Ok(ViewAttr { path, needs, key, kind })
	})
}

fn doc(attrs: &[Attribute]) -> String {
	let lines: Vec<String> = attrs
		.iter()
		.filter(|a| a.path().is_ident("doc"))
		.filter_map(|a| match &a.meta {
			Meta::NameValue(nv) => match &nv.value {
				Expr::Lit(ExprLit { lit: Lit::Str(s), .. }) => Some(s.value()),
				_ => None,
			},
			_ => None,
		})
		.map(|l| l.strip_prefix(' ').unwrap_or(&l).to_owned())
		.collect();
	lines.join("\n").trim().to_owned()
}

/// The params a path names, checked: `""` (a nest at the root) or `/`-led segments, each a
/// `[a-z0-9_-]` word or a `{param}`.
fn params(path: &LitStr, nest: bool) -> Result<Vec<String>> {
	let s = path.value();
	let fail = |why: &str| Err(Error::new(path.span(), format!("{s:?}: {why}")));
	if s.is_empty() {
		return if nest { Ok(vec![]) } else { fail("a view's path starts with `/`") };
	}
	let Some(rest) = s.strip_prefix('/') else { return fail("a path starts with `/`") };
	if rest.is_empty() {
		return if nest { fail("a nest at the root is `\"\"`") } else { Ok(vec![]) };
	}
	let mut params = Vec::new();
	for seg in rest.split('/') {
		match seg.strip_prefix('{').and_then(|p| p.strip_suffix('}')) {
			Some(p) => {
				if p.is_empty() || p.starts_with(|c: char| c.is_ascii_digit()) || !p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
					return fail("a param is a snake_case field name");
				}
				if params.iter().any(|q| q == p) {
					return fail("a param is named once");
				}
				params.push(p.to_owned());
			}
			None if !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-') => {}
			None => return fail("a segment is a `[a-z0-9_-]` word or a `{param}`, and none is empty"),
		}
	}
	Ok(params)
}

fn snake(ident: &Ident) -> String {
	let mut out = String::new();
	for (i, c) in ident.to_string().chars().enumerate() {
		if c.is_uppercase() && i > 0 {
			out.push('_');
		}
		out.extend(c.to_lowercase());
	}
	out
}

struct Field {
	ident: Ident,
	name: String,
	ty: Type,
	doc: String,
}

fn derive(input: DeriveInput) -> Result<Tokens> {
	let ident = &input.ident;
	if !input.generics.params.is_empty() {
		return Err(Error::new_spanned(&input.generics, "a views enum is not generic: its table is one static"));
	}
	let Data::Enum(data) = &input.data else {
		return Err(Error::new(ident.span(), "`Views` derives on an enum, a view per variant"));
	};
	if data.variants.is_empty() {
		return Err(Error::new(ident.span(), "a views enum has a view"));
	}
	let p = quote!(::ev_lib::views::__private);
	let views = quote!(::ev_lib::views);

	let mut carried = quote!();
	for attr in input.attrs.iter().filter(|a| a.path().is_ident("views")) {
		attr.parse_args_with(|input: ParseStream| {
			let name: Ident = input.parse()?;
			if name != "carried" {
				return Err(Error::new(name.span(), "`#[views]` takes `carried = <type>`"));
			}
			input.parse::<Token![=]>()?;
			let ty: Type = input.parse()?;
			carried = quote!(b.carried::<#ty>(););
			Ok(())
		})?;
	}

	let (mut entries, mut ats, mut froms) = (Vec::new(), Vec::new(), Vec::new());
	let mut keys: BTreeMap<char, Ident> = BTreeMap::new();
	let mut takes_any = false;
	for v in &data.variants {
		let vident = &v.ident;
		let mut attrs = v.attrs.iter().filter(|a| a.path().is_ident("view"));
		let (Some(attr), None) = (attrs.next(), attrs.next()) else {
			return Err(Error::new(vident.span(), "a view has one `#[view(\"/path\", …)]`"));
		};
		let a = view_attr(attr)?;
		let name = snake(vident);
		let description = doc(&v.attrs);
		let fields: Vec<Field> = match &v.fields {
			Fields::Unit => vec![],
			Fields::Named(named) => named
				.named
				.iter()
				.map(|f| {
					let ident = f.ident.clone().expect("named fields have idents");
					Field {
						name: ident.to_string().trim_start_matches("r#").to_owned(),
						ident,
						ty: f.ty.clone(),
						doc: doc(&f.attrs),
					}
				})
				.collect(),
			Fields::Unnamed(_) => return Err(Error::new(vident.span(), "a view's fields are named: their names are its params' and query keys'")),
		};
		let named = params(&a.path, !matches!(a.kind, Kind::Plain))?;
		for n in &named {
			if !fields.iter().any(|f| &f.name == n) {
				return Err(Error::new(a.path.span(), format!("`{{{n}}}` names no field of {vident}")));
			}
		}
		let (path_fields, rest): (Vec<&Field>, Vec<&Field>) = fields.iter().partition(|f| named.contains(&f.name));
		takes_any |= if matches!(a.kind, Kind::Nest) { !path_fields.is_empty() } else { !fields.is_empty() };
		if let Some(key) = &a.key {
			if !named.is_empty() {
				return Err(Error::new(key.span(), "a key opens a view with nothing to fill: this one has path params"));
			}
			if matches!(a.kind, Kind::Nest) {
				return Err(Error::new(key.span(), "a nest's views keep their own keys"));
			}
			let c = key.value();
			if !c.is_ascii_graphic() {
				return Err(Error::new(key.span(), "a key is one printable ASCII char"));
			}
			if let Some(other) = keys.insert(c, vident.clone()) {
				return Err(Error::new(key.span(), format!("'{c}' is {other}'s key already")));
			}
		}
		let path = a.path.value();
		let needs = match &a.needs {
			Some(e) => quote!(::core::option::Option::Some((#e).as_str())),
			None => quote!(::core::option::Option::None),
		};
		let key = match &a.key {
			Some(k) => quote!(::core::option::Option::Some(#k)),
			None => quote!(::core::option::Option::None),
		};
		let schema = |f: &&Field| {
			let (n, ty, d) = (&f.name, &f.ty, &f.doc);
			quote!((#n, b.schema::<#ty>(#d)))
		};
		let path_schemas: Vec<Tokens> = path_fields.iter().map(schema).collect();
		let all_idents: Vec<&Ident> = fields.iter().map(|f| &f.ident).collect();
		let pattern = match &v.fields {
			Fields::Unit => quote!(Self::#vident),
			_ => quote!(Self::#vident { #(#all_idents),* }),
		};
		let pairs = |fs: &[&Field]| -> Vec<Tokens> {
			fs.iter()
				.map(|f| {
					let (n, i) = (&f.name, &f.ident);
					quote!((#n, #p::value(#i)))
				})
				.collect()
		};
		let takes = |fs: &[&Field]| -> Vec<Tokens> {
			fs.iter()
				.map(|f| {
					let (n, i) = (&f.name, &f.ident);
					quote!(#i: f.take(#n)?)
				})
				.collect()
		};
		if !matches!(a.kind, Kind::Nest) && description.is_empty() {
			return Err(Error::new(vident.span(), "a view has a `///`: it is what an agent picks it by"));
		}
		match &a.kind {
			Kind::Plain => {
				let query_schemas: Vec<Tokens> = rest.iter().map(schema).collect();
				entries.push(quote! {{
					let params = ::std::vec![#(#path_schemas),*];
					let query = ::std::vec![#(#query_schemas),*];
					b.view(#name, #path, #description, #needs, #key, params, query);
				}});
				let all: Vec<&Field> = fields.iter().collect();
				let pairs = pairs(&all);
				ats.push(quote!(#pattern => #p::at(#name, ::std::vec![#(#pairs),*])));
				let takes = takes(&all);
				let build = match &v.fields {
					Fields::Unit => quote!(Self::#vident),
					_ => quote!(Self::#vident { #(#takes),* }),
				};
				froms.push(quote!(#name => {
					let v = #build;
					f.done()?;
					::core::result::Result::Ok(v)
				}));
			}
			Kind::Nest => {
				let [inner] = rest[..] else {
					return Err(Error::new(vident.span(), "a nest has its path's params and one field more, its inner view"));
				};
				let (inner_ident, inner_ty) = (&inner.ident, &inner.ty);
				entries.push(quote! {{
					let params = ::std::vec![#(#path_schemas),*];
					b.nest(#name, #path, #needs, params, <#inner_ty as #views::Views>::table());
				}});
				let pairs = pairs(&path_fields);
				ats.push(quote!(#pattern => #p::nested(#name, #views::Views::at(#inner_ident), ::std::vec![#(#pairs),*])));
				let takes = takes(&path_fields);
				let prefix = format!("{name}.");
				froms.push(quote!(v if v.starts_with(#prefix) => {
					let v = Self::#vident {
						#(#takes,)*
						#inner_ident: <#inner_ty as #views::Views>::from_at(f.rest(&view[#prefix.len()..]))?,
					};
					::core::result::Result::Ok(v)
				}));
			}
			Kind::Foreign { service, scope } => {
				let [below] = rest[..] else {
					return Err(Error::new(vident.span(), "a nest has its path's params and one field more, `below`"));
				};
				if below.name != "below" {
					return Err(Error::new(below.ident.span(), "a foreign nest's one field past its path is `below: String`, the href under it"));
				}
				let scope = match scope {
					Some(s) => quote!(::core::option::Option::Some(#s)),
					None => quote!(::core::option::Option::None),
				};
				entries.push(quote! {{
					let params = ::std::vec![#(#path_schemas),*];
					b.foreign(#name, #path, #description, #service, #needs, #key, #scope, params);
				}});
				let all: Vec<&Field> = fields.iter().collect();
				let pairs = pairs(&all);
				ats.push(quote!(#pattern => #p::at(#name, ::std::vec![#(#pairs),*])));
				let takes = takes(&all);
				froms.push(quote!(#name => {
					let v = Self::#vident { #(#takes),* };
					f.done()?;
					::core::result::Result::Ok(v)
				}));
			}
		}
	}

	let f = if takes_any { quote!(mut f) } else { quote!(f) };
	Ok(quote! {
		impl #views::Views for #ident {
			fn table() -> &'static #views::Table {
				static TABLE: ::std::sync::OnceLock<#views::Table> = ::std::sync::OnceLock::new();
				TABLE.get_or_init(|| {
					let mut b = #p::Builder::empty();
					#carried
					#(#entries)*
					b.build(::core::any::type_name::<Self>())
				})
			}

			fn at(&self) -> #views::At {
				match self {
					#(#ats,)*
				}
			}

			fn from_at(at: #views::At) -> ::core::result::Result<Self, #views::Error> {
				let (view, #f) = #p::Fields::new(<Self as #views::Views>::table(), at)?;
				match view.as_str() {
					#(#froms,)*
					_ => ::core::unreachable!("Fields::new refuses a view the table has not"),
				}
			}
		}
	})
}

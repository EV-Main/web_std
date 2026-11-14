//! Build-time: the `///` of every `async fn` under the crate's `src/`, for `api_docs!()`.

use std::{
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
};

use syn::{Attribute, Expr, ExprLit, Item, Lit, Meta};

/// Call from `build.rs`: writes `$OUT_DIR/api_docs.rs`.
pub fn write() {
	let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets it for build scripts"));
	let krate = std::env::var("CARGO_PKG_NAME").expect("cargo sets it for build scripts").replace('-', "_");
	let src = manifest.join("src");
	println!("cargo::rerun-if-changed={}", src.display());
	let mut found = Vec::new();
	walk(&src, &src, &krate, &mut found);
	found.sort();
	let mut out = String::from("&[\n");
	for (path, doc) in found {
		writeln!(out, "\t({path:?}, {doc:?}),").expect("writing to a String");
	}
	out.push(']');
	let dest = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets it for build scripts")).join("api_docs.rs");
	fs::write(dest, out).expect("OUT_DIR is writable");
}

fn walk(root: &Path, dir: &Path, krate: &str, found: &mut Vec<(String, String)>) {
	for entry in fs::read_dir(dir).expect("src is readable") {
		let path = entry.expect("src is readable").path();
		if path.is_dir() {
			walk(root, &path, krate, found);
			continue;
		}
		if path.extension().is_none_or(|e| e != "rs") {
			continue;
		}
		let rel = path.strip_prefix(root).expect("walked from root").with_extension("");
		let mut module: Vec<String> = rel.iter().map(|s| s.to_string_lossy().into_owned()).collect();
		if matches!(module.last().map(String::as_str), Some("lib" | "main" | "mod")) {
			module.pop();
		}
		let file = syn::parse_file(&fs::read_to_string(&path).expect("src is readable")).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
		let prefix = std::iter::once(krate.to_owned()).chain(module).collect::<Vec<_>>().join("::");
		items(&file.items, &prefix, found);
	}
}

fn items(list: &[Item], prefix: &str, found: &mut Vec<(String, String)>) {
	for item in list {
		match item {
			Item::Fn(f) if f.sig.asyncness.is_some() => {
				let doc = doc(&f.attrs);
				if !doc.is_empty() {
					found.push((format!("{prefix}::{}", f.sig.ident), doc));
				}
			}
			Item::Mod(m) =>
				if let Some((_, inner)) = &m.content {
					items(inner, &format!("{prefix}::{}", m.ident), found);
				},
			_ => {}
		}
	}
}

fn doc(attrs: &[Attribute]) -> String {
	let lines: Vec<String> = attrs
		.iter()
		.filter_map(|a| match &a.meta {
			Meta::NameValue(nv) if nv.path.is_ident("doc") => match &nv.value {
				Expr::Lit(ExprLit { lit: Lit::Str(s), .. }) => Some(s.value()),
				_ => None,
			},
			_ => None,
		})
		.map(|l| l.strip_prefix(' ').map_or_else(|| l.clone(), str::to_owned))
		.collect();
	lines.join("\n").trim().to_owned()
}

# `@evinvest/keymap`

Scoped keybinds, zero deps: a root the page claims, scopes a root chord opens (a leader), the
which-key hint for the open scope, every bound leaf for a help, and which key a keydown is across
layouts. The TypeScript twin of the `keymap` Cargo feature of [`ev_lib`](../../rust/src/ui/keymap.rs);
the rules are in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#the-keymap-library), and
`tests/fixtures/keymap/` pins the behaviour both suites run.

A React page uses it through `@evinvest/uikit`'s `KeymapProvider` and `useBinding`, not directly.

```ts
import { Trie, keyInput, currentPlatform } from "@evinvest/keymap";

const trie = new Trie(
  { root: [{ on: { key: "s", alt: true }, label: "leader", children: [{ on: { key: "u" }, id: "undo", run: undo }] }] },
  currentPlatform(),
  () => true,
  run => run.name,
);
window.addEventListener("keydown", e => {
  const step = trie.key(keyInput(e));
  if (step.kind === "pass") return;
  e.preventDefault();
  if (step.kind === "run") step.command();
});
```

| Rust                           | TS                                          |
| ------------------------------ | ------------------------------------------- |
| `Chord { key, ctrl, .. }`      | `{ key, ctrl? }`                            |
| `Node::Run { id, command }` / `Node::Scope` | `{ on, id, run: command }` / `{ on, label, children }` |
| `C: Display` labels a leaf     | the `label` argument of `new Trie`          |
| `Step::Run { command, .. }`    | `{ kind: "run", command, sequence }`        |
| `Option<Hint>`, `Option<&C>` (`command(id)`) | `Hint \| undefined`, `C \| undefined` |
| a panic on a bad keymap        | a thrown `Error`                            |
| `editable: Option<bool>`       | `editable: boolean` — only a DOM event reaches it; Rust's `None` is a non-web Dioxus renderer, which can't tell |

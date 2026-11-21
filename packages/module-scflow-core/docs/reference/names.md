<!-- Generated from module.yaml by the build of the package. Do not edit. -->

# Supply chain flow: names

A person, a script or an assistant designates an instance of these schemas by its **name**, never by its id.
Give the name as short as it stays unambiguous, and never an id that you were not given.

- A name is unique among the instances that share a **scope**, whatever their schema. Two instances of different scopes may have the same name.
- The **qualified name** of an instance is the qualified name of its scope, ` / `, then its own name. The scope is the first relation of `name_scope` that the instance has set; when the list is empty, the scope is the dataset.
- A reference is a name, or the end of a qualified name: `Line 1`, or `Lyon / Line 1` when two sites have a `Line 1`. A level of the chain may not be skipped. The spaces around `/` do not matter, and a name cannot contain `/`.
- A reference that matches no instance, or several, is an error. An ambiguity error lists the qualified names of the candidates: choose one and give more of it.
- A localized name may be given in any language, and is written in the source language of the project.

| Schema | Name | Scope | Qualified name |
| --- | --- | --- | --- |
| `actor_type` | localized | the dataset | `<actor_type>` |
| `item_type` | localized | the dataset | `<item_type>` |
| `actor` | plain text | the first of `parent_actor`, `scope` that is set | `<parent_actor> / <actor>` |
| `item` | plain text | the dataset | `<item>` |
| `transformation_type` | localized | the dataset | `<transformation_type>` |
| `transformation` | plain text | the first of `actor` that is set | `<actor> / <transformation>` |
| `mode` | localized | the dataset | `<mode>` |
| `route` | plain text | the dataset | `<route>` |
| `scope` | localized | the dataset | `<scope>` |
| `location` | plain text | the dataset | `<location>` |

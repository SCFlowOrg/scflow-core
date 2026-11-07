# Modules and names

A module owns schemas, scalar types and actions. It is declared in a manifest,
`module.yaml`, read without running code. The rules are in the specification:
[Module](spec/meta-model.md#module), [Names](spec/meta-model.md#names) and
[The Core Module](spec/meta-model.md#the-core-module). This page shows the API.

A dataset uses modules and embeds them (see [datasets.md](datasets.md), Modules
of a dataset). A module set also stands apart from any dataset.

## Read a manifest

`readModuleManifest(text)` parses YAML or JSON and validates it as an instance of
the `module` schema of `mcl:core`, with `validateModuleManifest`. It returns a
`ModuleManifest` with its defaults set.

```ts
import { readModuleManifest } from "@scfloworg/core";

const carbon = readModuleManifest(`
name: acme:carbon
namespace: carbon
version: 1.2.0
mcl: ^1.0
dependencies:
  - module: scflow:core
    version: ^1.3
schemas:
  - name: site
    extends: scflow.actor
    properties:
      - name: co2
        type: number
`);
```

A manifest is refused with `constraint_violation` when:

- `name` is not a `module_key`, `namespace` not an `identifier`, `version` not a
  `semantic_version` or `mcl` not a `version_range`; a missing one breaks its
  pattern;
- it carries a key that `module` does not declare;
- a dependency is `mcl:core`, the module itself, or listed twice;
- a schema or a scalar type is named with something other than an identifier,
  such as a qualified name, or with a primitive (`string`, `number`, `integer`,
  `boolean`);
- an action id is not the namespace of the module, a slash and an identifier, or
  its `kind` or `exposure` is outside its enum.

A name used twice in a module, by schemas and scalar types together, or an action
id used twice, throws `duplicate_name`.

The manifest keeps its schemas and scalar types as authored. They are processed
when the module joins a module set, where the names they use resolve. The
`parameters`, `writes` and `body` of an action, and `migrations`, are kept as
given.

## Put modules together

`createModuleSet(manifests)` puts modules together with `mcl:core`, which is
always there, and processes their schemas and scalar types.

```ts
import { createModuleSet } from "@scfloworg/core";

const set = createModuleSet([scflow, carbon]);
set.resolveSchema("scflow.actor");          // outside a module: a qualified name
set.resolveSchema("site", "acme:carbon");   // in a module: its own short name
set.requireSchema("actor");                 // throws unknown_schema
```

- Two modules with one namespace, or a module with the namespace `mcl`, throw
  `namespace_conflict`. A module key given twice, or `mcl:core`, throws
  `duplicate_name`.
- A qualified name written in a module that names a module other than itself, a
  dependency or `mcl:core` throws `reference_outside_module`.
- A name that does not resolve fails as in schema processing: a property `type`
  with `unknown_scalar_type`, an `extends` with `unknown_extends_target`.
- A dependency missing from the set is not refused, but its names do not
  resolve. Versions are not checked.

## Resolve a name

`resolveSchema(name, from?)` and `resolveScalarType(name, from?)` resolve `name`
as written in module `from`, or outside a module when `from` is absent. They
return the module, the definition and the `key`, or `undefined`.
`requireSchema` throws `unknown_schema` instead of returning `undefined`.

| Written | Short name | Qualified name |
| --- | --- | --- |
| In module `from` | `from`, then `mcl:core` | `from`, a dependency or `mcl:core` |
| Outside a module | `mcl:core` only | any module of the set |

A short name is never searched for across modules. A definition of a module
wins over one of `mcl:core` with the same name, and `mcl.date` still names the
one of `mcl:core`.

`context(from?)` gives the `TypeResolutionContext` that `resolveType` takes,
with the same rules.

## Canonical names

A processed schema of a module keeps its short `name`, and every name it
references, a property `type`, `extends`, `facet_of`, in its canonical form: the
qualified name, such as `scflow.code`, or the short name for `mcl:core`, such as
`date`. A canonical name resolves from anywhere in the set, so a schema that
extends one of another module keeps the references of that module. The `key` of
a resolved name is that canonical form, and it is the key of the definition in a
dataset.

A map type takes qualified names too: `{scflow.code: number}`.

## mcl:core

`MCL_CORE` is the manifest of `mcl:core`, embedded in the engine: namespace
`mcl`, version `MCL_CORE_VERSION`, `1.0.0`. It holds the meta-model (`schema`,
`property`, `constraint`, `scalar_type`, `dataset`, `dataset_module`, `import`,
`module`, `module_dependency`, `action`) and the standard scalar types with the
patterns of the specification, plus `markdown`. Unlike any other manifest, its
schemas and scalar types are already normalized: the meta-model names types built
into the engine, such as `constraint_value`, that have no schema of their own.

# Model specification

The modelling language: a meta-model of schemas, properties and constraints, the Model Command Language that queries and edits datasets, and its TypeScript reference implementation.

This document describes the need (Why), the conceptual model (What), and the reference implementation in TypeScript (How).

This specification is normative: the code follows it. The other files of [`docs/`](../) are usage guides.

## [Why modelling](why-modelling.md)

- [What is a Dataset](why-modelling.md#what-is-a-dataset): A dataset is a structured cohesive collection of data processed a a single unit
- [What is a Model](why-modelling.md#what-is-a-model): A model is the formal description and rules to structure a dataset
- [Meta Model](why-modelling.md#meta-model): The meta model is the model for all models
- [Integrity](why-modelling.md#integrity): The model describes constraint to maintain dataset integrity
- [Extensibility](why-modelling.md#extensibility): The model must be extensible without creating new entities
- [Data Storage](why-modelling.md#data-storage): The dataset can be stored under different formats
- [Composition](why-modelling.md#composition): Dataset may reference external instances
- [Version Upgrade](why-modelling.md#version-upgrade): The model is versioned and dataset upgradable
- [Modelling Language](why-modelling.md#modelling-language): A modeling language allows to query, create, update delete in datasets

## [The meta model](meta-model.md)

- [Transient Objects](meta-model.md#transient-objects): The YAML and JSON serialization of an instance
- [Instance](meta-model.md#instance): An entity is an object with a schema
- [Schema](meta-model.md#schema): Define properties and constraints for entities
- [Property](meta-model.md#property): Describes a property for the instances of a schema
- [Placeholders](meta-model.md#placeholders): String expansion is default values
- [Internationalization](meta-model.md#internationalization): Holding a property's text in several languages with the localized_string and localized_markdown map types
- [Constraints](meta-model.md#constraints): An integrity rule for a schema or a property
- [Schema Constraints](meta-model.md#schema-constraints): Constraints valid for schemas
- [Property Constraints](meta-model.md#property-constraints): Constraints valid for properties
- [Scalar Types](meta-model.md#scalar-types): Scalar value for properties
- [Relations](meta-model.md#relations): A property relating to another entity
- [On Delete](meta-model.md#on-delete): The on_delete relation constraint sets what happens to an instance when the target of its relation is deleted: restrict, cascade or set_null
- [Ownership](meta-model.md#ownership): Each instance has an owner in the dataset
- [Dataset](meta-model.md#dataset): A unit for persistence
- [Module](meta-model.md#module): The unit that contributes schemas, scalar types and actions to a model, declared in a manifest
- [Action](meta-model.md#action): An operation of a module, declared apart from its body
- [Names](meta-model.md#names): Short and qualified names of schemas and scalar types, and how they resolve
- [The Core Module](meta-model.md#the-core-module): `mcl:core` holds the meta-model and the standard types
- [Keys](meta-model.md#keys): A string used to reference a shared instance within a dataset
- [Import](meta-model.md#import): A dataset's local, namespaced copy of another dataset's model and data, kept aligned through upgrade and refresh
- [Model Upgrade](meta-model.md#model-upgrade): Upgrading data to an updated model
- [Import Refresh](meta-model.md#import-refresh): Refreshing imported data
- [Transient Language](meta-model.md#transient-language): Programming language for transient data
- [Persistent Formats](meta-model.md#persistent-formats): Format for dataset persistence
- [ER Diagram](meta-model.md#er-diagram): ER diagram of the meta-model

## [The model command language](model-command-language.md)

- [Language Model](model-command-language.md#language-model): The modeling language is itself defined using a model
- [Command](model-command-language.md#command): One operation on the instances of a schema: query, create, update or delete, with its filters, input and result shaping
- [Filter](model-command-language.md#filter): The filter schema used to restrict which instances of a schema a command matches
- [Script](model-command-language.md#script): An ordered sequence of commands, chaining named results into later input
- [Schema Processing](model-command-language.md#schema-processing): Turning a schema authored with the properties/constraints convention into a clean schema definition for the interpreter
- [Examples](model-command-language.md#examples): Worked examples of query, create, update and delete commands against a simple example model, plus a script chaining several of them

## [Typescript reference implementation](typescript-reference-implementation.md)

- [API Import](typescript-reference-implementation.md#api-import): Importing a dataset and refreshing an import through the TypeScript API
- [Persistence Interface](typescript-reference-implementation.md#persistence-interface): The interface a persistent format implementation must provide to the modeling language

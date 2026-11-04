# Why modelling

## What is a Dataset

*Concept.*

A **dataset** is a structured, cohesive collection of related **objects** managed and processed as a single unit, regardless of whether it is stored in a file, a database, or memory.
Each object is made of  **data points** (text, number, ...) and can be linked to other objects through **relations**.

If I am modeling **supply chain flows** a dataset could be a project or a blueprint of my supply chain. It will contain different kinds of objects:
- **actors** such as customers, production sites, warehouses, suppliers, … with datapoints such as: **names**, **address**, **capacity**, ...
- **flows** between actors, with datapoints such as **capacity**, **lead time**
- **items** such as products, with data points such as **name**, **weight**, ...
There could be relations such as:
- **source** and **target** from flows to actors
- **flowing items** from flows to items 

If I am writing **documentation** a dataset could be a library of documents. It will contain:

- **documents** such as specifications, user manuals, … with a **title** and an **author**
- **document parts** such as definitions, figures, requirements, … with a **title** and a **content**
There could be a relation
- **parts** from the document to the document parts

## What is a Model

*Concept.*

For a human, an AI or a code to understand and manipulate efficiently a dataset requires a formal and structured description of it's content and the integrity rules that govern it.
We will call this description the **model**.

This is not a new pattern — it is found in many places under different names. For example, they can be called the **artifact** and the **blueprint**. The artifact is what is made (the dataset); the blueprint is the description of what to make (the schema). 
In cooking, the blueprint is the recipe, the artifact is the cake or stew you will actually eat.
In music the blueprint is the score, the artifact is the live performance.
In engineering the blueprint is the engineering drawings and the artefact is the actual building, ship or car.

Some artifacts have no blueprint: beavers do not make an engineering drawing before building a dam. Making an artifact without a blueprint can also be called *improvising*. Some blueprints leave room for interpretation and may boil down to a simple set of rules, rules you can even break if the result is better. There are also blueprints without artifacts: castles in the sky.

In engineering we frown on improvisation. We love blueprints so much that we consider them artifacts too. This is not new: a cooking recipe, a music score, the blueprints of a ship can be exchanged and sold, and creating them is a well-respected trade.

Some blueprints can be turned into artifacts by a machine, without much interpretation — think of a 3D printer or, less recently, the punched tapes of automatic looms, music boxes and player pianos. For music there is also the MIDI standard: much less room for interpretation than a score, but less exciting than a real live performance.

In IT we push the confusion beyond recognition. Everything is an artifact (data set), and many artifacts are also blueprints: source code for other programs, software to run a computer, documents, engineering drawings, protocols, workflows…

The model of a model (considered as a dataset) is called the [Meta Model](#meta-model)


If I am modeling **supply chain flows** the model would define what is an actor, what is an item what is a  flow (with a source and target actors and items flowing) …

If I am writing **documentation** the would define what is a document as a collection of document parts …

## Meta Model

*Requirement.*

There should be only one meta model, the model used to describe all models (considered as datasets)
The meta model is inspired from the [Entity Relationship (ER) model](https://en.wikipedia.org/wiki/Entity%E2%80%93relationship_model) 
The meta-model itself is a model so it can be viewed as a dataset and it is its own meta-model.

We will name:
- **Instances** the objects in the dataset and **Entities** the objects in the model that describe instances
- **Properties** the data points in the dataset and **Attributes** the data points in the entities that describe the properties of instances
- **Relations** the relations between instances and **Relationships** the relation between entities that describe relations

The Entities, Attributes and Relationships in a model can be fully specified as Instances, Properties and Relations  form the meta-model.

## Integrity

*Requirement.*

The model must provide  mechanism to describe constraints or integrity rules.
Integrity can be enforced ideally at data creation or update, and it can also be checked on an existing dataset.

## Extensibility

*Requirement.*

The model must provide mechanisms to extend it's modelling power without changing the meta-model. New entities can be part of the same dataset as their instances.

## Data Storage

*Requirement.*

The dataset is the unit of data storage, new storage formats can be added and they should need only access to model to store the dataset.
A dataset can be transferred from a storage format to another one without loss.

A data format can be **transient** or **persistent**

**Transient**
The data lives temporary in the memory of an application, this is typically data structures in a programming language. Any "modern" programming language should be able to store a transient dataset.  The minimum required is Javascript/Typescript.
If the language is 'compiled' there should not be a need to recompile to accept an extended model.
In a transient format it is possible to handle instances and modify directly properties and relations however this may break integrity. Dataset can be handled in a transient format but it is not required for entities to be in a dataset.

**Persistent**
The data is always in a dataset and has a certain duration of persistence. 
The data can be in memory for an application or a server and the duration is limited to one or multiple interactive sessions.
The data can be in a long term storage like a file system of a database.

A persistent data format can be **serialized**, **editable** or **transactional**

**Serialized** 
A format is 'serializable' it supports only two operations
- full serialization of a dataset from another format
- full deserialization of a dataset to another format
It is required to support at least **JSON/YAML** serialization structured by the model. Other serialized formats can be defined or based on the JSON/YAML (binary, encrypted, ...)
With JSON/YAML serialization and deserialization are implemented either:
- against a transient model using native JSON/YAML parser / dumper
- against an editable format using the MCL command language, the parser / dumper should be generic and know only the meta-model. The entities and relations definitions should be queried from the dataset.

**Editable** 
A format is 'editable' if the content of the dataset can be queried, created, modified and deleted using the command language.

**Transactional** 
An editable format is 'transactional' if it offers **transactions**, the change to the dataset can be atomic and consistent. In case of error a valid state is recovered. A transaction yields a delta whose revert allows to implement undo/redo.

**Locators**
There should be a **"locator"** mechanism similar to [**URL**](https://en.wikipedia.org/wiki/URL) to allow to locate a dataset in persistent storage. This locator should be a string and start by encoding the name of the persistent format. The rest of the locator is format dependant.

## Composition

*Requirement.*

Instances in a dataset may have relations with instances from other datasets. 
Two examples:
- A dataset instances use schemas from a 'modeling' dataset shared with many other datasets in the same business area.
- A dataset  instances have relations to instances in  a 'foundation/library' for example documents may share definitions, assemblies may share common parts, supply chains may share products.

A dataset can be composed by **"importing"** other datasets. 
A dataset can be autonomous in persistence by "caching" the instances they use from imported datasets.
A dataset will register the **locator** of an imported dataset to be able to reconnect and update when they changed independently  (see [Version Upgrade](#version-upgrade))

## Version Upgrade

*Requirement.*

A dataset should keep two version, one for the model (entities) and one for the data (instances).
When the model is composed it should keep track of the version of the datasets referred. (see [Composition](#composition))

When the instances in a dataset have their entities located in another dataset this other dataset the model may have changed for a new version while the instances are still using cached entities.

In that case the model should provide a way to upgrade, most of the time it should be new properties with default values. Otherwise an upgrade mechanism should be proposed.

## Modelling Language

*Requirement.*

A modeling language is available to perform the following "**commands**" on a dataset:
- query  entities (meta-model instances) in the dataset using the meta-model
- query  instances using the model
- create, update and delete entities in the dataset
- create, update and delete instances in the dataset

The modeling language interface is independent from any implementation, it is based on a specific command language model with entities describing the commands.
The command language model also supports **scripts**: an ordered sequence of commands, executed in order, where a command can name its result (`as`) so a later command in the same script can use it as input — see [Script](model-command-language.md#script).

A script is a transient object like [Command](model-command-language.md#command) or [Filter](model-command-language.md#filter): no persistence mechanism of its own is needed — recording and replaying one is just serializing it to and from JSON/YAML like any other transient object.

A modeling language implementation is specific to:
- A transient model (programming language)
- A version of the meta-model
- An editable persistent format [Data Storage](#data-storage)

It takes the form of a library of functions to:
- initialize with a dataset locator
- execute command calls described the transient format
- get the results in the transient format

From the library in any supported language it is possible to create CLI tools that:
- Serialize / serialize between JSON/YAML and a persistant editable format
- Execute serialized scripts on a serialized dataset and serialize the updated dataset
- Provide an REPL to interact with a dataset in a persistant editable format:
	- Define 'variables' to store references to entities obtained from commands
	- Write command calls in YAML using primitive types and variables
	- Execute a command call and store the results in variables

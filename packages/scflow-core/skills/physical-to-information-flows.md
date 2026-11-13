# Build the information flows of a SCFLOW model from its physical network

Use this methodology when the user asks to derive, from the physical network of
a SCFLOW model, the actors and information flows that drive it: the
forecast-to-stock and order-to-cash processes and the S&OP process. The user may
give only a partial description of what they look for; ask what the model and
the description do not establish.

Write in the language of the user, whatever the language of this method. Name
types, items, actors and scopes with the vocabulary of the user, in their
language; action ids stay as written here.

## 1. Inspect the physical network first

- Use the read tools offered to inspect the open dataset. Continue only for a
  SCFLOW model, one that uses the module `scflow:core`. If no dataset is open, ask
  the user to open or create a SCFLOW dataset first.
- Read the actors, their types and scopes, the items held at each actor, the
  flows and the items they carry, the conversions and the transformations.
- **Stop when the physical network is empty**: when no flow carries a `physical`
  item, say so and stop. Information flows are derived from a physical network,
  never invented without one. Suggest building the physical network first, from
  a description or a diagram, and do nothing else.
- Reuse the information types, items and actors that already exist. Read the
  notes and tags of the entities: they may already record an order policy or a
  process.

## 2. Find the decoupling points

For each family of finished products, find its **decoupling point**: the most
downstream held item that is stocked against a forecast. Upstream of it, the
network is driven by forecasts; downstream, by customer orders. Classify each
family:

| Situation | Stock held against forecast | Customer order triggers |
| --- | --- | --- |
| MTS, make to stock | Finished product, at a warehouse or a plant | Picking and shipping |
| ATO, assemble to order | Components or intermediates | Final assembly, then shipping |
| MTO, make to order | Raw materials only | Production, then shipping |
| ETO, engineer to order | None, or generic materials | Design, procurement and production |

Read the signs in the model: a finished product held at a warehouse or at a
distribution actor points to MTS; components held before a final transformation,
with no stock of the finished product, point to ATO; only raw materials held at
the plant point to MTO.

The rule behind it is the P:D ratio: D is the delivery lead time the customer
accepts, P the cumulated lead time to source, make and deliver. When D is shorter
than P, stock is needed upstream of the point where the remaining lead time fits
in D. A network can hold several families with different situations; a
distribution network can also hold MTS stock at several echelons.

Record each decoupling point with `scflow/add_tags` on the held item, with the
tags `decoupling-point` and the situation (`MTS`, `ATO`, `MTO`, `ETO`), and the
reasoning, with its lead times when known, in a note with `scflow/add_note`.

## 3. Ask before deriving

Ask a concise, grouped clarification, only for what changes the model:

1. The delivery lead time customers accept, per product family, when the model
   does not settle the situation.
2. Who receives customer orders and through which channel: a customer service
   desk, a customer portal, an ERP system, EDI.
3. Who forecasts, at which level (product family, region), and how often.
4. Whether an S&OP process exists, who takes part in it, and its cadence.
5. The information systems in place, when the user wants them as actors: ERP,
   planning system, portal.

State the classification of step 2 and let the user correct it before creating
anything. Leave unanswered points as assumptions in notes, never as silent
choices.

## 4. Derive the processes

Each process is a **scope**: a lane that holds the information actors of the
process. Create one scope per process found, with `scflow/create_scope`, and
describe in it the process and its trigger.

**Forecast-to-stock**, for each stock held against a forecast:

- forecast, by the demand planner, from sales history and market input;
- replenishment or production order, by the supply planner, from the forecast
  and the stock held;
- purchase order to the supplier, or production order to the plant, that
  replenishes the decoupling point.

**Order-to-cash**, from the customer to the decoupling point:

- customer order, from the customer to the order desk, portal or ERP system;
- for ATO, MTO and ETO, a production or assembly order to the plant, or a
  purchase order for ETO;
- shipping order to the actor holding the stock, then a shipping notice to the
  customer;
- invoice to the customer. **The process stops at the invoice**: payment and
  every `financial` item are out of this method.

**S&OP**, a process with its own actors and information flows, at the level of
product families and over months:

- a demand review: the demand planner sends the demand plan;
- a supply review: the supply planner sends the supply plan, with capacities;
- a consensus meeting that receives both plans and produces the S&OP plan;
- the S&OP plan flows down to the planners of forecast-to-stock, and frames
  the forecasts and the replenishment.

Information flows run upstream of the physical flows: demand goes from the
customer towards the suppliers, while products go from the suppliers towards the
customer. Do not add procure-to-pay, transport planning or other processes
unless the user asks for them.

## 5. Map to the model

- **Actors.** Create the information actors as roles of a process: order desk,
  demand planner, supply planner, S&OP committee. Each actor belongs to at most
  one scope; put each new actor in the scope of its process. An existing physical
  actor keeps its scope: a customer, a plant or a warehouse whose type includes
  the `information` domain sends and receives orders itself. When one system,
  such as an ERP, serves several processes and the user wants it as one actor,
  ask in which process lane it belongs and note the others.
- **Types.** Reuse the information types of the base library when present: ERP
  system, Planner, Customer portal; Order, Forecast, Message, Invoice. Create
  others with `scflow/create_actor_type` and `scflow/create_item_type`, with the
  `information` domain, only when none fits. An actor type that must exchange
  information and hold products has both domains.
- **Items.** Create each information item once, as a family, with
  `scflow/create_item`: Forecast, Customer order, Purchase order, Production
  order, Shipping notice, Invoice, Demand plan, Supply plan, S&OP plan. Not one
  item per document or per product.
- **Held items.** A queue of orders or a plan held by an actor is a held item,
  with `scflow/hold_item`.
- **Flows.** One flow per information exchange, with `scflow/create_flow` and
  its `item`. The item's domain must be among the domains of both ends: check the
  actor types before creating the flow.
- **Conversions and transformations.** A one-to-one change of an order is a
  conversion with `scflow/create_conversion`: a customer order turned into a
  production order at the order desk. A step that combines several inputs is a
  transformation: the supply planner consuming a forecast and a stock status and
  producing replenishment orders, or the S&OP committee consuming the demand and
  supply plans and producing the S&OP plan. Use `scflow/define_process`, after
  creating its type with `scflow/create_transformation_type`.
- Keep lead times, cadences, assumptions and the reasoning for each choice as
  notes with `scflow/add_note`.

## 6. Propose and execute model actions

Briefly state the classification, the processes and the actors and flows to
create, with the open assumptions. Use only the tools and actions actually
offered to this assistant, and inspect their current parameter schemas rather
than guessing fields.

Create prerequisites before dependent entities: scopes and types, then items,
actors, held items, flows, conversions and transformations. When a batch of
actions is offered, make the whole change as one approved batch rather than with
several action calls in the same answer, and write its steps as its description
says. Do not bypass approval, run MCL, generate executable scripts, or fall back
to direct writes. If an action is missing, report the unsupported operation
rather than inventing a tool. Never delete or change physical entities to fit the
derived processes; report the mismatch instead.

How the lanes are displayed is up to the application. Never write presentation
records directly.

## 7. Read back and report

After approved actions complete, read the affected schemas again to confirm the
result. Report, in the language of the user, the situation of each product
family, the processes created with their actors and flows, what was reused, the
assumptions left in notes, and any action failure. Do not claim that changes
succeeded without readback.

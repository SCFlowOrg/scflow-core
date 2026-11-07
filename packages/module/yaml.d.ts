// The import of a `.yaml` file, such as the manifest of a module in its
// `src/module.ts`. `buildModule` inlines the parsed file as data.
declare module "*.yaml" {
  const value: Readonly<Record<string, unknown>>;
  export default value;
}

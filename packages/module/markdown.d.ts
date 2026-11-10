// The import of a `.md` file, such as the body of a skill in the
// `src/module.ts` of a module package. `buildModule` inlines its text.
declare module "*.md" {
  const text: string;
  export default text;
}

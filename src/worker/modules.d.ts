// The build gives this import the bundled module's code as a string
declare module "*/coreModule?module&inline" {
  const code: string;
  export default code;
}

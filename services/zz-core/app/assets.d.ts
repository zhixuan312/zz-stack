/** An image the build inlines: esbuild's `dataurl` loader turns the import into its data: URL. */
declare module "*.png" {
  const url: string;
  export default url;
}

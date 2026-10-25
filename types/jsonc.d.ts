// wrangler.jsonc の rules（Text・*.jsonc）で、shop.jsonc は「文字」として import される。その型
declare module '*.jsonc' {
  const text: string;
  export default text;
}

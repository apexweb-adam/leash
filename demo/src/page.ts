/**
 * Turn a web page into the text an AI agent "sees". Like most scrapers it
 * keeps hidden elements and drops tags, which is exactly how hidden
 * prompt injections reach the model.
 */
export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fill the {{MERCHANT}} / {{ATTACKER}} placeholders of the fixture page. */
export function renderFixture(html: string, vars: { merchant: string; attacker: string }): string {
  return html.replaceAll("{{MERCHANT}}", vars.merchant).replaceAll("{{ATTACKER}}", vars.attacker);
}

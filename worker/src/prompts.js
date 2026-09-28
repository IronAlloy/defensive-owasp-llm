// Assembles the system prompt for a level, injecting planted secrets from canaries.
export function buildSystemPrompt(levelCfg, canaries) {
  let s = levelCfg.system || "";
  return s
    .replaceAll("{{MASTER_CODE}}", canaries.master_discount_code)
    .replaceAll("{{STAFF_CODE}}", canaries.staff_discount_code)
    .replaceAll("{{PARTNER_CODE}}", canaries.partner_discount_code)
    .replaceAll("{{API_KEY}}", canaries.fake_api_key)
    .replaceAll("{{CANARY}}", canaries.prompt_canary);
}
// Wrap tool results as untrusted data when the level requires it.
export function wrapData(text, flags) {
  if (!flags.wrapUntrustedData) return text;
  return `<untrusted_data>\n${text}\n</untrusted_data>`;
}

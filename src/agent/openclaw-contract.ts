/**
 * What the OpenClaw side may run: ONE program (the built Hunter façade) with one of a few fixed shapes. The same expression is written
 * in `openclaw/exec-approvals.example.json` (a test keeps the two identical), so the agent's permission and the façade's own parsing
 * cannot drift apart. The phrase for `ask` may hold letters (accents included), digits and spaces only: no quote, `;`, `&`, `|`, `$`,
 * backtick, redirection or backslash can reach a shell, and the façade still accepts nothing outside its catalogue.
 */
export const OPENCLAW_ARG_PATTERN =
  '^dist/cli/hunter\\.js (status|more|help|hunt( freelancer| 99freelas)?|top( ([1-9]|10))?|ask --text [A-Za-zÀ-ÿ0-9 ]{1,60}) --sender [0-9]{3,15} --chat [0-9]{3,15}$';

# Adversarial review: multi-environment credentials

Date: 2026-09-05. Scope: specification and current implementation, not a completed
implementation audit. Verdict: proceed with the corrected design.

## Findings addressed

1. **High — dotenv re-parsing changes secrets.** SOPS emits literal `#` values;
   npm dotenv treats unquoted `#` as a comment. Confirmed locally using SOPS
   3.13.3 and age 1.3.2 with a fresh identity held in memory: an encrypted
   `demo#suffix` round trip returned `dotenvPreserves: false` and
   `jsonPreserves: true`. No actual credentials or Bunny requests were used.
   Resolution: encrypted dotenv input, JSON output, own-property string
   selection, no expansion or trimming. Quotes in SOPS dotenv input are literal.
   Evidence: [SOPS dotenv store](https://github.com/getsops/sops/blob/main/stores/dotenv/store.go).

2. **High — failure reporting can expose decrypted output.** Child-process errors
   can carry stdout/stderr; JSON parser errors can contain input snippets. The
   current purge implementation includes raw HTTP bodies and retry messages are
   logged. Resolution: classify SOPS errors into fixed messages without causes,
   suppress parser excerpts, omit purge response bodies, and redact exact
   resolved credentials at builder logging and returned-error boundaries.
   This does not cover arbitrary output from Angular builds or encoded secrets.

3. **Medium — process isolation was overstated.** Not mutating `process.env` with
   decrypted values prevents accidental sharing, but inherited age identities
   remain visible to trusted build code. Traditional dotenv loading also has
   pre-existing cross-workspace contamination when names are reused. Resolution:
   scope isolation to SOPS credential maps and document both boundaries; do not
   change global legacy dotenv behavior in this release.

4. **Medium — permissive lookup and input handling.** Empty filenames must not
   silently select legacy mode, and inherited object fields must not count as
   credentials. Resolution: validate optional fields before source selection,
   distinguish null/undefined from empty strings, validate selected JSON values,
   reject directory inputs and avoid normalizing secret values.

5. **Medium — timeout and compatibility claims needed precision.** A timeout with
   graceful termination is not a firm stop if the process ignores it. Making
   `loadSecrets` async or options mandatory would break existing callers.
   Resolution: force termination of the direct SOPS child; bounded capture;
   retain the synchronous loader and `Deps.loadSecrets` name, widening only the
   dependency return type. New configuration fields remain optional.

## Remaining limits accepted in the design

- Correct zone/build/Pull Zone configuration remains the deployer's responsibility.
- SOPS executable, PATH, repository and build scripts must be trusted.
- Private age key provisioning, rotation and process-tree isolation are outside scope.
- Redaction is exact-value defense against accidental leaks, not containment of
  malicious code or transformed secrets. JavaScript memory cannot be guaranteed wiped.
- Real integration tests and Angular configuration/default tests are required
  before claiming the implementation is compatible. No production deployment
  or implementation test suite was run as part of this document review.

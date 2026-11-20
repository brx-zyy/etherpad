# Security Report: Same-site Cross-Origin WebSocket Hijacking of Etherpad Admin Settings

## Summary

Etherpad's privileged Socket.IO `/settings` namespace does not validate the WebSocket handshake `Origin`. Its session middleware accepts the browser's session cookie, and the namespace authorizes the connection solely by checking whether the session user is an administrator.

An attacker who can serve JavaScript from a **same-site, cross-origin sibling subdomain** can cause an authenticated administrator's browser to open a WebSocket to Etherpad. With the default `SameSite=Lax` cookie policy, the browser still attaches the Etherpad session cookie to this same-site request.

The browser-level reproduction demonstrated that the attacker origin can:

1. Read the raw settings file through the `load` event.
2. Overwrite the settings file through the `saveSettings` event.

This is a same-site CSWSH / privileged WebSocket origin-validation vulnerability. It is **not** demonstrated as exploitable from an arbitrary unrelated website when the default Lax cookie policy is in effect.

## Affected component

- Project: Etherpad
- Version tested: 3.3.19
- Namespace: Socket.IO `/settings`
- Relevant handlers: `load`, `saveSettings`
- Cookie policy tested: `SameSite=Lax`
- Tested code commit: `2e7d2158cfc620772b2ce9b1298f29bd28f0375d`

The test ran against an isolated Etherpad instance started by GitHub Actions, not a third-party or production deployment.

## Preconditions

- The victim is authenticated to Etherpad as an administrator.
- The attacker can execute JavaScript from a different origin that is nevertheless same-site with the Etherpad origin. Examples include a compromised or attacker-controlled sibling subdomain under the same registrable domain.
- The victim visits the attacker-controlled page while the admin session remains active.
- The attacker and Etherpad origins use the same scheme for schemeful same-site classification.

A sibling subdomain is cross-origin even though it is same-site. The browser's SameSite cookie policy therefore does not provide the protection that it provides against an unrelated site.

## Technical root cause

### 1. WebSocket session middleware does not enforce Origin

In `src/node/hooks/express/socketio.ts`, `socketSessionMiddleware` passes the handshake request through Express session middleware. The Socket.IO server and the `/settings` namespace use this middleware, but the setup does not install an explicit Origin allowlist or reject an untrusted handshake Origin.

Source: [socketio.ts](https://github.com/brx-zyy/etherpad/blob/develop/src/node/hooks/express/socketio.ts#L54-L69) and [namespace setup](https://github.com/brx-zyy/etherpad/blob/develop/src/node/hooks/express/socketio.ts#L111-L125).

### 2. Admin authorization is session-only

In `src/node/hooks/express/adminsettings.ts`, the `/settings` connection handler checks `socket.conn.request.session.user.is_admin`. It does not additionally validate the handshake Origin.

Source: [adminsettings.ts](https://github.com/brx-zyy/etherpad/blob/develop/src/node/hooks/express/adminsettings.ts#L68-L82).

### 3. The namespace exposes privileged read and write operations

The `load` event reads `settings.settingsFilename` and emits the raw settings file in the `settings.results` field when settings display is enabled.

The `saveSettings` event writes the client-supplied string directly to `settings.settingsFilename` and emits a `saveprogress: saved` acknowledgement.

Source: [adminsettings.ts](https://github.com/brx-zyy/etherpad/blob/develop/src/node/hooks/express/adminsettings.ts#L84-L110).

### 4. SameSite=Lax does not stop same-site sibling-origin requests

Etherpad configures the Express session cookie's SameSite value from `settings.cookie.sameSite`.

Source: [express.ts](https://github.com/brx-zyy/etherpad/blob/develop/src/node/hooks/express.ts#L208-L220).

SameSite is not an origin boundary. A sibling subdomain can be cross-origin but same-site, so Lax does not prevent the cookie from accompanying the WebSocket handshake in this scenario.

## Reproduction evidence

### Automated browser test

- Workflow: [Browser CSWSH reproduction — successful run](https://github.com/brx-zyy/etherpad/actions/runs/44690647623)
- Test source: [adminSettingsCswsHBrowser.ts](https://github.com/brx-zyy/etherpad/blob/security-repro-import-temp-leak/src/tests/backend/specs/admin/adminSettingsCswsHBrowser.ts)
- Workflow source: [cswsH-browser-repro.yml](https://github.com/brx-zyy/etherpad/blob/security-repro-import-temp-leak/.github/workflows/cswsH-browser-repro.yml)
- Commit tested: `2e7d2158cfc620772b2ce9b1298f29bd28f0375d`
- Result: **1 passing** browser integration test.

The workflow installed the project dependencies and Chromium, started Etherpad locally, authenticated a test administrator, and used separate browser origins mapped to local loopback listeners:

- Target: `http://pad.etherpad.test:<port>`
- Attacker: `http://evil.etherpad.test:<port>`
- Unrelated-site control: `http://attacker.invalid:<port>`

The test used a session cookie scoped to the target host with `SameSite=Lax`. It verified:

1. The sibling-origin page connected to the target `/settings` namespace over WebSocket.
2. The page received a unique marker placed in the test settings file.
3. The page emitted `saveSettings` with a second unique marker.
4. Etherpad acknowledged the save, and the test process verified the second marker in the settings file on disk.
5. The unrelated-site control did not receive the settings disclosure.

The successful workflow log also records the server-side message:
`Admin request to save settings through a socket on /admin/settings`.

This is a real Chromium browser integration test against a live, ephemeral Etherpad process. It is not a test against a publicly deployed production instance.

## Security impact

A successful attack acts with the victim administrator's privileges on the `/settings` namespace:

- **Confidentiality:** raw settings content may disclose secrets or sensitive deployment configuration stored there.
- **Integrity:** an attacker can replace the settings file with attacker-controlled content.
- **Availability:** malicious configuration changes may disrupt the instance. The exact operational impact depends on the settings changed and deployment configuration.

The reproduction directly proves settings disclosure and settings-file overwrite. It does not claim arbitrary filesystem write or remote code execution.

## Scope and limitations

- Confirmed: browser-based same-site, cross-origin sibling-subdomain attack with the default Lax cookie policy.
- Confirmed: read of settings data and overwrite of the settings file through the admin WebSocket namespace.
- Confirmed control: an unrelated site did not obtain the settings in the tested Chromium environment with Lax.
- Not tested: a production deployment, reverse-proxy-specific behavior, every browser/version, or deployments configured with `SameSite=None`.
- Exploit precondition: attacker control of a same-site sibling origin and an authenticated administrator victim.

## Recommended remediation

1. Enforce an explicit, exact Origin allowlist on the WebSocket handshake before session-authenticated namespaces are accepted. Use the configured canonical public origin; do not derive trust from an unvalidated `Host` header.
2. Apply the check to the default namespace and every privileged namespace, including `/settings` and `/pluginfw/installer`.
3. Reject missing, malformed, `null`, and untrusted Origin values for browser-authenticated WebSocket connections.
4. Keep the existing admin-session authorization checks as a separate control.
5. Add regression tests that verify an allowed Origin succeeds and a sibling/untrusted Origin is rejected in a real browser.

Changing SameSite cookie settings may be useful defense in depth, but it is not a substitute for WebSocket Origin validation.

## Suggested classification

- Category: Cross-Site WebSocket Hijacking / WebSocket Origin Validation
- CWE: CWE-346 (Origin Validation Error); CWE-352 (Cross-Site Request Forgery) may also be relevant.
- Severity: High, provisional. The attacker must control a same-site origin and the victim must have an active admin session; the demonstrated impact includes reading and overwriting administrator settings.

## Suggested disclosure note

Please assess this report against the upstream development branch and supported release lines. The reproduction is isolated and does not access or modify any third-party deployment.

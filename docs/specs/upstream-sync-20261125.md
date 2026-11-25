# 2026-11-25 upstream integration (ZCode v4.0.0)

## Scope and decisions

Merge upstream `v4.0.0` (`a4b44451`, five upstream sync commits `a60ba6a7..a4b44451`: `v3.17.2` `a9fe401e`, `v3.18.0` `b95ebaff`, `v3.18.1` `c5904686`, `v3.18.2` `fec97590`, `v4.0.0` `a4b44451`) onto `canary` as a single merge commit without pushing to remotes.

User-confirmed integration decisions:

1. Retain `"3.20.171"` as root `package.json` version on `canary`.
2. In `local-mode`, hide Voice Input and Share Management UI and skip `IVoiceInputService` registration while keeping upstream implementations dormant.
3. Enforce `upstream-network-policy/node` across `extension-host`, `preinstalled-tools/process.ts`, and `nodeApiNetwork.ts` `createWebSocket`, and allowlist read-only `GET`/`HEAD` requests under `/zcode/preinstalled-tools/` on `cdn-zcode.z.ai` and `cdn.codegeex.cn`.
4. Omit `<SettingsRow searchId="settings.agentAlwaysBackground" ... />` in `codex-collaboration` (guarded in `scripts/fork-removal-rules.mjs`), and classify the 16 new v4.0.0 tools in standard `tool-modes` while removing deleted `ReadSessionContext`.
5. Eliminate the `web-auth` <-> `web-remote-control` module cycle by moving `SelfHostedRemoteLoginPage` to `packages/web/src/web-remote-control/ui/selfHostedRemoteLoginPage.tsx` (re-exported via `packages/web/src/web-remote-control/views.ts` and wired in `packages/web/src/main.tsx`) and restoring `packages/web/src/auth/WebLoginPage.tsx` to `MERGE_HEAD`.
6. Retire the two pure-upstream dormant cloud Coding Plan test files (`packages/services/test/codingPlanSubscriptionService.test.ts` and `packages/ui/test/modelProviderCodingPlan.test.ts`) from `scripts/fork-test-files.json` and git, and align drifted `fork-contracts` and CLI core tests to v4.0.0 contracts without restoring retired upstream App unit tests.

## Architecture adaptation and removal invariants

- Declared `fork-upstream-network` in `requires` for `extension-host` (`packages/desktop/src/extension-host/module.ts`, `architecture-policy.yaml`) and `preinstalled-tools` (`packages/desktop/src/preinstalled-tools/module.ts`, `architecture-policy.yaml`).
- Exposed `apps/zcode-cli/packages/core/src/runtime/helpers/agent-listing.ts` under `codex-collaboration-runtime.publicEntrypoints` in `architecture-policy.yaml`, and declared `codex-collaboration-runtime` in `requires` for `context-composition` (`packages/shared/src/zcode-protocol-v4/context-composition/module.ts`, `architecture-policy.yaml`).
- Adapted `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` to remove the pre-v4.0.0 duplicate `resolveAppRuntimeConfig` invocation and `getSubagentOutputRootDir` import, wiring `FORK(tool-modes)` after v4.0.0 `resolveAppRuntimeConfig`.
- Adapted `packages/web/src/web-remote-control/` (`contract.ts`, `contracts/selfHostedRemoteAuth.ts`, `adapters/selfHostedRemoteAuth.ts`, `app/webRemoteControlEntry.ts`) to support `"zai_cn"` providers, `getSessionRevision()` / `subscribeSessionChange()`, and `startLogin` teardown on failure.
- Added removal guards in `scripts/fork-removal-rules.mjs` for `local-mode` (`extension-host/index.ts`, `preinstalled-tools/process.ts`, `nodeApiNetwork.ts`, `packages/services/src/node.ts` `IVoiceInputService`, `ConversationComposer.tsx`, `settingsPageConfig.ts`) and `codex-collaboration` (`settingsPageHelpers.tsx` `settings.agentAlwaysBackground`), plus unit coverage in `packages/shared/src/fork/upstream-network/contract.test.ts`, `packages/services/test/nodeApiClient.test.ts`, `packages/web/test/selfHostedRemoteAuth.test.ts`, and `packages/ui/test/settingsPageConfig.test.ts`.

## Test alignment summary

- Updated `pnpm test:unit:fork` suites (`forkEditStaleGuard.test.ts`, `forkIdentityPresetContext.test.ts`, `forkReload.test.ts`, `forkToolModeTools.test.ts`) for v4.0.0 `WriteErrorCode.STALE_FILE`, `collectSkillsListing`, `offeredMcpTools`, and 38-tool `basic` allowlist (`ReadSessionContext` removed).
- Aligned `fork-contracts` suites for v4.0.0 contracts: `autoUpdaterReadyState.test.ts`, `hostRemoteStartupIntegration.test.ts` (v4.0.0 `InitLocal` `settingService.get()` and extension-host globals), `localServicesRemoteAuthority.test.ts` (`ZCODE_CREDENTIAL_SECRET` and `oauth:active_provider` required by `OAuthCredentialRepo.materialFromSnapshot()`), `settingsPageConfig.test.ts` (`agentBehavior` section and `computerUse` ordering), `v4ConversationTelemetrySupervisor.test.ts` (`send_type`), `webRemoteControlTransportV2.test.ts` (`Math.random` spied before `fixture()` captures it in `WebRemoteControlV2RetryPolicy`), `toolPresentationParity.test.ts` (`TooltipProvider` and `"Bash"` label `"Ran"`), `toolCallBlocks.test.ts` (removed `isExploreToolCall` and legacy `·` separator checks superseded by flex `gap-2` layout, wrapped in `TooltipProvider`, aligned terminal label to `"已执行"`), and `v4AssistantWorkRenderItems.test.ts` (removed deleted `enableChangesGrouping` and legacy grouping cases while retaining single-row, deferred/failed shell, and `pairSubagentRows` coverage).
- Aligned CLI core tests: `tests/tool-contracts.test.ts` (v4.0.0 Bash description bullets while preserving embedded-search `Avoid using this tool` distinction) and `tests/tool-search-subagent.test.ts` (Explore child expectations under default embedded search excluding `Glob`/`Grep` and keeping `Bash`/`Read`/`WebFetch`).

## Validation record

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 538 warnings and 0 errors across 5,988 files; targeted Oxlint React Hooks audit over 19 fork-modified/added React files reported 0 errors, 0 `react/rules-of-hooks` diagnostics, 60 warnings in untouched upstream hook arrays, and 0 new/related Hooks warnings on fork edits (`selfHostedRemoteLoginPage.tsx`: 0 warnings).
- `node scripts/architecture/architecture-check.mjs check`: passed with 0 violations (`baseline: 0`, `new: 0`); `pnpm run test:architecture`: 61/61 passed.
- `pnpm fork:check-removals`: passed across 11,172 scanned code/config files with all five feature invariants satisfied (`codex-collaboration`, `local-mode`, `github-update`, `webfetch-direct-return`, `offpeak-removal`).
- `pnpm test:unit:contracts`: 56/56 files passed, 940/940 tests passed (148.63s).
- `pnpm test:unit:fork`: 10/10 groups passed (340/340 tests).
- CLI builds and typechecks (`@zcode/contracts`, `@zcode/adapters`, `@zcode/core`, `@zcode/bootstrap`, `@zcode/cli`) passed; targeted `@zcode/core` Vitest (`tests/tool-contracts.test.ts`, `tests/tool-search-subagent.test.ts`, `tests/context-composition`) passed 4/4 files (49/49 tests); `@zcode/bootstrap` targeted Vitest (`subagent-session-query.test.ts`, `context-composition/`) passed 3/3 files (6/6 tests).
- Engineering targeted checks: `node --test scripts/test/fork-test-project.test.mjs scripts/test/fork-collaboration-client-removals.test.mjs` passed 3/3; `node --test scripts/test/release-workflow.test.mjs` passed 15/15; `pnpm test:engineering packages/desktop/test/radixMenuListenerPatch.test.ts` passed 2/2.
- `pnpm docs:stale-phrases:check` and `pnpm db:schema:check`: passed across 2,425 doc files and 8/8 schema checker cases plus both SQLite baselines.
- `pnpm exec node scripts/run-cli-lint.mjs`: exited 1 with `CLI lint: 2 errors, 90 warnings, 3 pristine upstream line-count diagnostics`; the 2 errors are `eslint(max-lines)` on v4.0.0-expanded fork-modified files `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts` (809 lines) and `apps/zcode-cli/packages/core/src/agent/message-history.ts` (801 lines). Neither suppressed nor refactored.
- Known unverified scope: Desktop, Web, and mobile GUI/E2E test suites and live Windows/macOS/Linux Electron runs were not executed in this merge pass.

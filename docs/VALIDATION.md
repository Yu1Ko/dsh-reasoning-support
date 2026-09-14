# Release validation / 发布验证

Recorded on 2026-09-14 for version `0.1.0`, runtime `672c8d1599e973a0`.

## Automated checks

On Windows with Node.js 24.18.0:

- `npm test`: **39 passed, 0 failed** — 28 runtime tests and 11 installer/rollback tests.
- `npm run check`: installer syntax and runtime content manifest passed.
- Installer checks use an isolated local DSH API fixture; they do not access a real account or make provider requests.
- Covered installation cases include fresh and existing presets, interrupted writes with recovery receipts, changed defaults, modified files, literal dollar sequences in YAML, existing/dangling directory links, and unrelated custom-style preservation.
- Runtime checks include model-route selection, native stream handling, cancellation, image bypass, stale-state prevention, compaction checkpoints, audit isolation, and Chinese/English extra-call opt-outs.

## Live DSH smoke test

The neutral preset was installed into an isolated DSH data directory and exercised with DSH `0.1.5-rc.1` and the configured model identifier `codebuddy/deepseek-v4.1-flash`.

- **Strict JSON with support:** 1 primary call and 2 accepted auxiliary calls; the final output parsed as the requested JSON object.
- **English opt-out:** 1 primary call, no auxiliary calls, and valid JSON output after “Do not make extra model calls”.
- **Native file operations:** 2 primary calls, 2 accepted auxiliary calls, and 1 shell-tool call; the resulting file was independently verified byte-for-byte against its source.
- The native request exposed 30 tools in that test environment. Tool count depends on the installed DSH composition.
- The main system prompt contained no fixed roleplay identity from the earlier prototype. Auxiliary audit records stayed outside the native session journal.

These are integration checks, not a broad reasoning benchmark. The official `deepseek-official/deepseek-flash` alias was exercised in earlier prototypes; the fresh neutral-release smoke test above used only the relay model identifier. Other model families have not been validated for the auxiliary pipeline and are not enabled by default.

## Review and publication boundary

The changed runtime, installer, and documentation were inspected locally. An optional independent model review could not start because its configured model route was unavailable; it is not counted as a completed review or approval.

No raw conversation journals, audit files, provider credentials, personal filesystem paths, or installation receipts are included in this repository. The original DeepSeek MIT copyright notice is retained alongside the project's MIT license.

## 中文摘要

- 此版本完成 **39 项自动化检查**，包含 28 项运行时测试和 11 项安装／回退测试；语法与内容清单校验通过。
- 在隔离的真实 DSH 环境中验证了三阶段纯 JSON 输出、英文关闭额外调用，以及实际文件读写；结果均通过，复制文件逐字节一致。
- 当前通用版的新鲜在线验证使用 `codebuddy/deepseek-v4.1-flash`。官方别名的调用证据来自更早的原型，其他模型家族尚未验证辅助流程。
- 已进行本地代码复核；可选的独立模型审查因所配路线不可用未能启动，没有把它计为通过。
- 这些检查证明已测试集成路径能够工作，不代表普遍答题正确率、等预算优势或工程提速。

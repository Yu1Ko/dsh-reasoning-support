# Validation / 验证记录

Version: **0.2.0**. Recorded on **2026-09-15**. Environment: Windows, Node.js **24.18.0**, DSH **0.1.5-rc.1**. The runtime file hashes are recorded in `manifest.json`.

## Automated checks

- **80 tests passed, 0 failed**: runtime behavior plus 11 installer/rollback cases.
- `npm run check`: installer syntax and content manifest verified.
- No model account is needed for these tests.
- Coverage includes image and attachment preservation, complete text-read verification, corruption and timeout handling, deferred parsing, native shell readers versus metadata-only results, cancellation, persistent opt-out, evidence references, full failure history after compaction, ordered freshness, repeated failures, no progress, repair/time/token limits, checkpoint limits, native stream pass-through and strict JSON output.
- Installer checks cover fresh/existing presets, interrupted writes and recovery receipts, concurrent default changes, modified files, literal YAML dollar sequences, directory links, and unrelated preset preservation.

## Native DSH integration

`npm run test:native` mounts the real preset into an isolated DSH home. A deterministic local provider controls the model responses; DSH's agent loop, attachment service and file tools execute normally. This isolates integration correctness from model variability.

Eight cases passed, with an additional image-history follow-up:

- **Strict JSON:** 1 primary call + 2 auxiliaries; the reviewer corrects the draft and the final response is valid JSON.
- **Artifact repair:** 6 primary calls + 3 auxiliaries. Native `write → read → write → read` first creates an intentionally incomplete file, then repairs the missing line and reads the corrected bytes. It remains one user turn.
- **Missing evidence:** 4 primary calls + 3 auxiliaries. Native `write → read` verifies the already-correct file without rewriting it.
- **Milestone:** 5 primary calls + 3 auxiliaries. Calling the checkpoint tool twice produces only one milestone model call.
- **Image plus preview:** analysis receives the original image; acceptance receives the original image and a distinct preview returned by native `read_image`. Image bytes are read through DSH's real attachment service.
- **Image-history follow-up:** a later text-only user message still sends the earlier image to analysis and acceptance.
- **Text attachment:** verified UTF-8 contents reach both auxiliary calls.
- **PDF attachment:** native shell execution invokes Python with `pypdf`, native `read` opens the extracted text, then analysis runs. The extracted code reaches analysis and acceptance. This uses 3 primary calls + 2 auxiliaries.
- **Explicit opt-out:** 1 primary call and no auxiliary calls.

The PDF fixture requires Python and `pypdf`. The local-provider tests prove the native integration and actual file operations; they do not measure DSV4.1's probability of choosing the right repair on arbitrary tasks.

## Actual DSV4.1 provider requests

An isolated configuration of `codebuddy/deepseek-v4.1-flash` was tested with `input: [text, image]`. The original route initially had no explicit image declaration. Its main, analysis and review HTTP requests were inspected for image content parts without retaining authentication headers in the validation results.

Three online cases passed:

- **Image recognition:** the generated picture has an orange left half and a blue right half. The final JSON identified both correctly. Analysis, primary execution and acceptance each sent one inline image part and received HTTP 200. Recorded elapsed time: approximately **6.6 seconds**.
- **Text follow-up after an image:** the answer remained correct JSON, and both auxiliary HTTP requests still contained the image. Approximately **5.5 seconds**.
- **Text attachment in that conversation:** a randomly generated code was recovered from the attachment. There were 2 primary calls and 2 accepted auxiliaries; the existing image context remained transmissible. Approximately **8.7 seconds**.

These timings describe these small test cases, not a performance guarantee. Each online case used the user's configured model route in an isolated DSH home.

## Additional live coverage and limits

An additional PDF live test exposed a real compatibility issue: the model used PowerShell `Get-Content` to display parsed text while the first implementation recognized only a dedicated read tool. The implementation and regressions now cover both ways of reading. A subsequent probe also caught early admission of parser metadata; only content-displaying reads can now release deferred analysis.

Final PDF online rechecks encountered provider response timeouts on the first primary call, before the deferred analysis could run. The test cancelled successfully at its deadline. **These attempts are not counted as successful online PDF validation.** The subsequent live engineering case was not reached. PDF parsing and same-turn engineering repair remain verified by the native integration tests above.

Independent code reviews found and prompted fixes for material timeouts, scoped opt-outs, image budgets, metadata-only reads, omitted failures, stale review cache reuse and checkpoint token accounting. Focused regression tests verify the fixes. These checks establish the tested behaviors; they do not establish a broad reasoning-accuracy gain, equal-budget superiority or a general oneshot engineering success rate.

## 中文摘要

- **80 项自动化测试通过**，安装器语法和运行时清单校验通过。
- 真实 DSH 循环的 **8 个集成场景及一次图片历史追问通过**。工程用例实际修改磁盘文件、重新读取，并保持在同一轮请求中；补证据用例没有重复写文件。
- 图片、图片后的文字追问和文本附件通过了 **3 项实际 DSV4.1 在线检查**。前置研判和复核的 HTTP 请求确实携带图片数据。
- PDF 已通过真实本地解析和原生集成验证；最终在线复测因提供方首次响应超时未完成，未计为通过。后续在线工程用例未执行。
- 完成独立代码审阅并修复发现的问题。上述测试验证功能与接入，不宣称已量化模型能力或工程成功率的提升。

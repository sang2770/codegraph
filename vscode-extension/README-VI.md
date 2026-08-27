# Hướng dẫn sử dụng CodeBrain for VS Code

CodeBrain giúp AI hiểu source code bằng semantic graph thay vì phải tìm kiếm và đọc nhiều file riêng lẻ. Extension cung cấp MCP server, Agent Skill, chat participant, phân tích ảnh hưởng thay đổi, phát hiện test liên quan và báo cáo Markdown.

## 1. Cài extension

### Cài từ file VSIX

1. Mở VS Code.
2. Mở Command Palette:
   - macOS: `Cmd + Shift + P`
   - Windows/Linux: `Ctrl + Shift + P`
3. Chạy lệnh **Extensions: Install from VSIX...**
4. Chọn file phù hợp với máy, ví dụ:

```text
codebrain-darwin-arm64.vsix
```

5. Reload VS Code khi được yêu cầu.

Mỗi VSIX chỉ chứa runtime của một nền tảng:

- `darwin-arm64`: macOS Apple Silicon
- `darwin-x64`: macOS Intel
- `linux-arm64`
- `linux-x64`
- `win32-arm64`
- `win32-x64`

Extension đã đóng gói sẵn Node.js, CodeBrain runtime và native Rust kernel. Người dùng không cần cài Node.js hoặc CLI riêng.

## 2. Khởi tạo CodeBrain cho project

1. Mở thư mục source code bằng VS Code.
2. Mở Command Palette.
3. Chạy:

```text
CodeBrain: Initialize Workspace
```

CodeBrain sẽ tạo thư mục:

```text
.codegraph/
```

Đây là local index của project. Index không được extension upload ra ngoài.

Sau khi hoàn thành, status bar hiển thị:

```text
CodeBrain: Ready
```

> Với repository lớn, lần index đầu tiên có thể mất một khoảng thời gian. Các lần cập nhật sau sử dụng incremental sync.

## 3. Tự động cập nhật index

Auto refresh được bật mặc định. Khi source code thay đổi, MCP runtime sẽ cập nhật index theo debounce.

Các setting liên quan:

```json
{
  "codebrain.autoRefresh.enabled": true,
  "codebrain.autoRefresh.debounceMs": 1000
}
```

Để cập nhật thủ công, chạy:

```text
CodeBrain: Refresh Index
```

Để xem trạng thái index:

```text
CodeBrain: Show Index Status
```

## 4. Giải thích workflow với `/explain`

Mở Chat trong VS Code và nhập:

```text
@codebrain /explain Giải thích workflow đăng nhập
```

Hoặc:

```text
@codebrain /explain Hàm này dùng để làm gì?
```

Bạn có thể chọn code trong editor trước khi gửi câu hỏi. CodeBrain sẽ tập trung vào file và đoạn code đang được chọn.

Báo cáo `/explain` gồm:

- Mục đích nghiệp vụ: workflow được kích hoạt khi nào, xử lý gì và trả về kết quả nào
- Các bước nghiệp vụ theo đúng thứ tự thực thi, gắn với function, file và line cụ thể
- Code-flow illustration dạng pseudo-code để developer dễ đối chiếu business step với code
- Control flow và data flow
- State, side effect và failure path
- Bằng chứng file và line từ CodeBrain
- Mermaid workflow flowchart cho đường thực thi chính
- Mermaid execution sequence cho thứ tự chạy giữa các function hoặc thành phần
- Mermaid data-flow hoặc state lifecycle diagram tùy theo bản chất của code

Kết quả được lưu thành file Markdown tạm và mở bằng Markdown Preview.

## 5. Review code với `/review`

Sau khi sửa code, nhập:

```text
@codebrain /review Review các thay đổi hiện tại
```

`/review` kết hợp:

- Git status và Git diff
- Code đang được chọn
- Call paths
- Callers và dependencies
- Blast radius từ CodeBrain

Báo cáo gồm:

- Mức rủi ro: Critical, High, Medium hoặc Low
- Findings được sắp xếp theo severity
- Hậu quả và workflow bị ảnh hưởng
- Regression test matrix
- Release recommendation

`/review` chỉ đánh giá code, không tự động sửa file.

## 6. Phân tích ảnh hưởng với `/impact`

Có hai cách chạy.

### Từ VS Code Chat

```text
@codebrain /impact Phân tích ảnh hưởng của các thay đổi hiện tại
```

### Từ Command Palette

```text
CodeBrain: Analyze Change Impact
```

Extension sẽ:

1. Thu thập file đã thay đổi từ Git.
2. Duyệt các dependency liên quan.
3. Phát hiện test bị ảnh hưởng.
4. Phân tích callers, workflows và public contracts.
5. Phân loại mức rủi ro.
6. Mở Workflow Graph.

Nếu Git không có file thay đổi, extension sử dụng file đang mở làm phạm vi phân tích.

Setting độ sâu dependency:

```json
{
  "codebrain.impact.maxDepth": 5
}
```

> Không phát hiện test bị ảnh hưởng không có nghĩa là không có regression. Extension sẽ ghi trường hợp này là một khoảng trống kiểm thử.

## 6b. Blast radius ngay trong editor (CodeLens)

Mỗi file hiển thị mức ảnh hưởng ngay trên dòng 1, không cần gõ lệnh:

```text
⚡ CodeBrain: 23 dependents · 2 affected tests
🧪 Run 2 affected tests
```

Bấm lens đầu để chạy phân tích ảnh hưởng đầy đủ, lens sau để chạy đúng các test đó.

Tắt bằng:

```json
{ "codebrain.codeLens.enabled": false }
```

## 6c. Chạy test bị ảnh hưởng

CodeBrain tìm ra test nào liên quan, và chạy luôn giúp bạn. Gọi từ CodeLens, thanh Source Control, panel impact, hoặc:

```text
CodeBrain: Run Affected Tests
```

Extension tự nhận diện test runner của project — Vitest, Jest, Playwright, Mocha, pytest, `go test`, RSpec, PHPUnit, Cargo, Maven, Gradle, `dotnet test` — và **luôn hiển thị lệnh để bạn xác nhận trước khi chạy**, vì việc nhận diện có thể sai.

Muốn bỏ qua bước nhận diện, đặt sẵn lệnh của bạn:

```json
{ "codebrain.tests.command": "npx vitest run ${files}" }
```

## 6d. Khi blast radius bị cắt

Nếu việc duyệt phụ thuộc dừng ở giới hạn `codebrain.impact.maxDepth` trong khi vẫn còn phần đồ thị chưa đi tới, báo cáo sẽ ghi rõ:

```text
⚠️ Kết quả bị cắt. Mọi con số dependent bên dưới là giới hạn dưới.
```

Lúc đó các con số hiển thị dạng `≥ N`, và độ tin cậy bằng chứng bị hạ xuống. Tăng `codebrain.impact.maxDepth` để thấy toàn bộ.

Tắt kiểm tra này bằng `codebrain.impact.detectDepthTruncation: false`.

## 7. Workflow Graph

Mở graph bằng:

```text
CodeBrain: Open Workflow Graph
```

Graph chia thành ba nhóm:

```text
Changed files → Dependents/workflows → Affected tests
```

Click vào một node để mở file source tương ứng. Nếu CodeBrain có line number, editor sẽ di chuyển đến vị trí đó.

Dashboard cũng hiển thị extraction engine:

- `Rust native`: đang sử dụng native Rust kernel
- `WASM fallback`: runtime không tìm thấy kernel tương thích

## 8. Dashboard chi phí context

Mở:

```text
CodeBrain: Token Savings Dashboard
```

Dashboard hiển thị:

- Số lần phân tích, và trong đó bao nhiêu lần **đo được**
- Context token từ CodeBrain
- Baseline đọc file (đo thật)
- Chênh lệch
- Số lượt đọc file tránh được
- Độ trễ lần phân tích gần nhất

**Cách đo.** CodeBrain lấy đúng các file mà nó đã trích bằng chứng, đọc **kích thước thật trên đĩa** của chúng, rồi quy đổi cả hai phía theo cùng tỉ lệ 4 byte ≈ 1 token. Khi không đo được file nào, dashboard ghi **không xác định** thay vì hiển thị một con số.

Đây là ước tính kích thước context, **không phải** dữ liệu billing của model.

## 8b. Trạng thái index và vùng thiếu bao phủ

```text
CodeBrain: Show Index Status
```

Panel hiển thị:

- Số file, symbol, quan hệ đã index, chia theo ngôn ngữ
- **Tracked only**: file có trong index nhưng không trích được symbol nào — chúng không thể xuất hiện trong call path
- **Coverage gaps**: file trong workspace nhưng không có trong index

Phần cuối quan trọng nhất: file thuộc ngôn ngữ chưa được hỗ trợ sẽ **vắng mặt hoàn toàn** khỏi đồ thị, nên mọi phân tích ảnh hưởng lẽ ra phải đi qua chúng đều bị thiếu — mà không có lỗi nào báo cho bạn biết.

Panel cũng cảnh báo khi lần index gần nhất bị rớt file, còn reference chưa resolve, hoặc được build bởi engine cũ.

## 8c. Monorepo nhiều project

Khi workspace có nhiều project đã index:

```text
CodeBrain: Choose Project
```

Mặc định CodeBrain dùng project đã index gần nhất phía trên file đang mở.

Tắt lưu metrics:

```json
{
  "codebrain.metrics.enabled": false
}
```

Reset metrics:

```text
CodeBrain: Reset Token Savings
```

Metrics chỉ được lưu trong workspace state của VS Code.

## 9. Read-only CodeBrain Reviewer

Trong Chat, mở agent picker và chọn:

```text
CodeBrain Reviewer
```

Reviewer agent chỉ được cấp các tool thuộc MCP server CodeBrain. Agent không có tool sửa file hoặc terminal.

### Phản hồi lại finding

Findings được giữ lại qua các lần reload cửa sổ, và tự bám lại đúng dòng sau khi bạn sửa code — báo rõ khi finding đã dịch chuyển, và thừa nhận khi dòng được review không còn tồn tại thay vì chỉ sai chỗ.

Khi một finding sai:

- Bấm bóng đèn (lightbulb) → **dismiss** — finding đó sẽ bị ẩn cả trong các lần review sau
- Bấm bóng đèn → **explain** — hỏi CodeBrain giải thích thêm trong Chat
- Trả lời trực tiếp trong comment thread của finding để hỏi lại

Khôi phục tất cả:

```text
CodeBrain: Restore Dismissed Review Findings
```

Ví dụ:

```text
Đánh giá rủi ro nếu thay đổi hàm refreshSession
```

```text
Kiểm tra blast radius của authentication middleware
```

```text
Các test nào cần chạy trước khi release thay đổi này?
```

## 9b. Sinh commit message

Bấm **icon ngôi sao** trên thanh tiêu đề Source Control, CodeBrain viết commit message thẳng vào ô nhập.

Nội dung mô tả các thay đổi **đã staged** — đúng những gì commit tới sẽ chứa — và nếu chưa staged gì thì lấy toàn bộ working tree. Nếu ô nhập đang có chữ, thông báo sẽ kèm nút **Undo** để khôi phục lại.

**Theo convention của bạn, không phải của chúng tôi.** Chạy **CodeBrain: Choose Commit Message Format** (cũng có trong menu `⋯` của Source Control) rồi chọn một kiểu — danh sách hiện ví dụ thật chứ không bắt bạn đoán qua cái tên:

| Format | Trông như |
| :--- | :--- |
| Conventional Commits | `feat(auth): add refresh tokens` |
| Issue key + summary | `TPLD-958: Fix Chart lag issue`, một dòng trống, rồi danh sách chi tiết lồng nhau `-` / `+` / `*` |
| Plain summary | `Fix chart lag when the window is resized` |

Đặt `codebrain.commit.language` để viết bằng ngôn ngữ khác, ví dụ `Vietnamese`. Tên biến, đường dẫn và mã issue được giữ nguyên.

Prompt còn mang theo **tên branch hiện tại** và vài commit subject gần nhất, nên format có thể lấy mã issue từ `feature/TPLD-958-chart-lag` và bám theo style sẵn có trong repo. Branch không có mã issue thì bỏ hẳn tiền tố chứ không bịa ra.

**Không format nào vừa ý?** Chọn **Custom template…** ngay trong danh sách đó (hoặc chạy **CodeBrain: Customize Commit Message Template**) để tạo `.codebrain/commit-template.md`, file được điền sẵn theo format đang dùng nên bạn sửa từ nội dung chạy được chứ không phải trang trắng. File đó **thay thế** format có sẵn — xoá luật nào là luật đó hết hiệu lực — và được đọc từ git repo root, nên commit vào repo là cả team dùng chung một convention. Xoá file thì quay lại dùng picker. Muốn để file ở chỗ khác thì đổi `codebrain.commit.templateFile`.

Message dùng model chọn ở **CodeBrain: Choose AI Model**.

## 10. Export báo cáo

Sau khi chạy `/explain`, `/review` hoặc `/impact`, dùng:

```text
CodeBrain: Export Latest Report as Markdown
```

Markdown giữ nguyên heading, tables, code blocks và Mermaid chart. File nhẹ, có thể preview trực tiếp trong VS Code, đọc lại bằng AI và review bằng Git diff.

## 10a. CodeBrain cho mọi agent — MCP server + Skill

Agent cần hai thứ để dùng CodeBrain hiệu quả: **MCP server** cung cấp tool đồ thị, và **skill** cho agent biết khi nào và dùng tool đó ra sao. Trong VS Code, Copilot nhận cả hai trực tiếp từ extension. Các agent khác đọc file riêng của chúng, nên hãy chạy **CodeBrain: Install CodeBrain for Agents (Claude, Codex, Gemini…)**, chọn phạm vi, chọn cài gì, tích agent đang dùng, rồi restart agent đó.

**MCP server**

| Agent | Global — mọi project | Chỉ workspace này |
| :--- | :--- | :--- |
| Claude Code | `~/.claude.json` | `<workspace>/.mcp.json` |
| Codex CLI | `~/.codex/config.toml` | — |
| Gemini CLI | `~/.gemini/settings.json` | `<workspace>/.gemini/settings.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` | — |

**Skill** — cài bằng đúng cơ chế gốc của từng agent nếu agent đó có, vì skill hay slash command chỉ được nạp khi thật sự cần, còn file instructions thì nạp vào **mọi** request:

| Agent | Cơ chế | Global | Chỉ workspace này |
| :--- | :--- | :--- | :--- |
| Claude Code | skill | `~/.claude/skills/codebrain/SKILL.md` | `<workspace>/.claude/skills/codebrain/SKILL.md` |
| Codex CLI | prompt — gõ `/codebrain` | `~/.codex/prompts/codebrain.md` | — |
| Gemini CLI | command — gõ `/codebrain` | `~/.gemini/commands/codebrain.toml` | `<workspace>/.gemini/commands/codebrain.toml` |
| Antigravity | mục trong instructions | `~/.gemini/GEMINI.md` | — |
| GitHub Copilot | mục trong instructions | — | `<workspace>/.github/copilot-instructions.md` |

Mọi agent nhận cùng một nội dung — `skills/codebrain/SKILL.md`, đúng file Copilot đang dùng — nên không có bản sao thứ hai để lệch nhau. Phần ghi vào file instructions được bọc trong marker `<!-- CODEBRAIN_SKILL_START -->` / `<!-- CODEBRAIN_SKILL_END -->`: nội dung bạn tự viết xung quanh được giữ nguyên, và khi gỡ thì chỉ mục có marker bị xoá. Copilot trong VS Code vốn đã có skill đóng gói sẵn, nên entry ở đây là để Copilot ở nơi khác dùng được — github.com, CLI, editor khác.

**Chọn phạm vi nào?** Global thường là lựa chọn hợp lý: entry MCP **không** ghim đường dẫn workspace, agent khởi động server ngay trong thư mục bạn đang làm việc và CodeBrain trả lời theo project đã index gần nhất — cài một lần dùng được cho mọi repo. Chọn phạm vi workspace khi muốn nó đi kèm repository (`.mcp.json` và các file skill commit được vì không chứa token) hoặc chỉ muốn project này thấy. Codex CLI và Antigravity không có cấu hình theo project nên chỉ hiện ở global; file instructions của Copilot thuộc về repository nên chỉ hiện ở phạm vi workspace.

Mỗi entry MCP trỏ tới runtime đóng gói sẵn trong extension, nên không cần cài Node.js, không cần `npm i -g`, và không lo PATH bị rút gọn khi agent được mở từ GUI. Repo chưa có `.codegraph/` thì server chỉ báo là chưa index; chạy **CodeBrain: Initialize Workspace** ở repo đó.

Mỗi lần cập nhật extension, đường dẫn runtime đổi theo version và nội dung skill cũng có thể đổi. CodeBrain tự ghi lại những gì nó đã tạo ở lần activate kế tiếp — đúng phạm vi bạn đã cài — nên agent vẫn chạy sau khi nâng cấp mà bạn không phải làm gì thêm. **CodeBrain: Uninstall CodeBrain from Agents** quét cả hai phạm vi và cả hai phần nên không sót gì.

## 10b. Tìm kiếm Collab (Confluence) và Jira cho mọi agent

CodeBrain đóng gói thêm một MCP server cho Jira và Confluence (Collab), để agent tra cứu ngay trong lúc làm việc: ticket đứng sau tên branch, spec đứng sau một quyết định thiết kế, thảo luận giải thích vì sao code lại như vậy.

Bảy tool đọc: `confluence_search`, `confluence_get_page`, `confluence_get_page_images`, `jira_search`, `jira_get_issue`, `jira_get_comments`, `jira_get_issue_images`. Nội dung page và description của issue trả về đầy đủ nên agent không cần bạn copy/paste — và hai tool ảnh trả về luôn screenshot, diagram đính kèm dưới dạng ảnh thật, để agent *nhìn* được lỗi thay vì đoán qua phần mô tả.

**Ghi dữ liệu là tuỳ chọn, mặc định tắt.** Bật `codebrain.atlassian.allowWrite` thì agent có thêm `jira_add_comment`, `jira_get_transitions`, `jira_transition_issue`, `jira_assign_issue`, `confluence_create_page`, `confluence_update_page`, `confluence_add_comment` — đủ để comment kết quả tìm được, chuyển ticket sang In Progress, nhận ticket, hoặc viết kết quả thành một page. Khi setting còn tắt, các tool đó **không hề xuất hiện** với bất kỳ agent nào, nên server chỉ có thể đọc. Mọi thao tác ghi đều báo lại chính xác cái gì đã đổi (status mới, version mới của page, URL trực tiếp), và cập nhật page mặc định là *append* chứ không phải ghi đè, nên agent không thể lặng lẽ xoá tài liệu của người khác.

### Cấu hình một lần, dùng cho tất cả agent

1. Chạy **CodeBrain: Configure Atlassian (Collab + Jira)**, nhập base URL và personal access token.
   - Server / Data Center: tạo token ở *Profile → Personal Access Tokens*.
   - Cloud: dùng API token và nhập email tài khoản khi được hỏi. URL Confluence Cloud phải có context path `/wiki`.
   - Có thể cấu hình chỉ Jira, chỉ Confluence, hoặc cả hai — tool của sản phẩm chưa cấu hình sẽ không hiện ra với agent.
2. GitHub Copilot nhận server ngay, không cần sửa file config nào.
3. Với **Claude Code**, **Codex CLI**, **Gemini CLI** hoặc **Antigravity**: chạy **CodeBrain: Register Atlassian MCP with Agents**, chọn phạm vi global hay workspace, chọn agent đang dùng, rồi restart agent đó.

### Token được lưu ở đâu

Token nằm trong keychain của hệ điều hành (VS Code SecretStorage) và được ghi thêm một bản duy nhất vào `~/.codebrain/atlassian.env` (quyền `0600`, chỉ owner đọc được) — đây là cách duy nhất để các agent ngoài VS Code đọc được. File config của agent mà CodeBrain ghi ra **chỉ chứa câu lệnh chạy server**, nên `.mcp.json` có commit vào repo cũng không lộ token.

- **CodeBrain: Test Atlassian Connection** — gọi thử một request đã xác thực cho từng sản phẩm.
- **CodeBrain: Unregister Atlassian MCP from Agents** — xoá entry khỏi config của các agent.
- **CodeBrain: Clear Atlassian Credentials** — xoá token, URL và file credentials dùng chung.

Log của phần này nằm ở Output channel **CodeBrain Atlassian**.

## 10c. Bảng Jira kèm mapping branch

Icon **CodeBrain** trên Activity Bar mở view **Jira Board**, dùng đúng credentials đã cấu hình ở phần trên — không phải đăng nhập lần hai. Lệnh **CodeBrain: Open Jira Board** mở bản rộng, có biểu đồ, trong một tab editor.

### Filter — cái nào tốn một request, cái nào không

Chip chọn phạm vi (*Mine*, *Reported*, *Watching*, *Everyone*) và cột tiến độ (*To do*, *In progress*, *Done*); dropdown filter theo deadline (quá hạn, hôm nay, trong tuần, chưa có due date); ngoài ra có ô project, toggle sprint đang mở, thứ tự sắp xếp, và ô tìm kiếm lọc theo key, summary, người phụ trách, label hoặc component ngay khi bạn gõ.

Chỉ những filter thuộc về câu query mới hỏi lại Jira; phần còn lại lọc trên tập đã tải nên phản hồi tức thì. Lựa chọn được ghi nhớ theo từng workspace.

### Cảnh báo — để không ticket nào bị bỏ quên

Các ô phía trên bảng đếm những thứ cần để ý: **quá hạn**, **gần đến hạn** (trong `codebrain.jira.dueSoonDays` ngày), **ì** (đang In progress nhưng `codebrain.jira.staleDays` ngày không có cập nhật), **chưa có người nhận**, và **đang làm nhưng không có due date**. Bấm vào một ô để chỉ xem nhóm đó. Ticket đã đóng thì không bao giờ bị cảnh báo. Mỗi card cũng hiện cảnh báo của riêng nó, kèm viền màu theo mức nghiêm trọng nhất.

### Biểu đồ thống kê

Bản đầy đủ có donut tiến độ kèm tỉ lệ hoàn thành, phân bố deadline, khối lượng theo từng người, và thống kê theo status — tất cả tính trên tập ticket đang hiển thị, nên đổi filter là biểu đồ đổi theo.

### Mapping sang git branch

Mỗi card biết những branch đang mang issue key của nó, và một click làm đúng việc cần làm:

- đã có branch local → chuyển sang branch đó (nếu đang có thay đổi chưa commit, CodeBrain hỏi trước vì git sẽ mang chúng theo);
- chỉ có branch remote của đồng nghiệp → tạo branch local track theo branch đó;
- chưa có gì → gợi ý tên theo `codebrain.jira.branchTemplate` (mặc định `{prefix}/{key}-{summary}`, nên `TPLD-958` thành `bugfix/TPLD-958-fix-chart-lag`) và cho bạn sửa trước khi tạo. Summary tiếng Việt được chuyển thành ASCII đọc được, và tên mà git từ chối sẽ được sửa trước khi gợi ý.

Nhiều branch cùng mang một key thì được liệt kê ra cho bạn chọn, không đoán. Lệnh **CodeBrain: Check Out Branch for a Jira Issue** làm cùng việc đó từ Command Palette hoặc menu Source Control, còn nút **Fetch branches** lấy về những branch đồng nghiệp vừa push.

### Chiều ngược lại, không cần mở gì

Status bar hiện issue key đọc từ tên branch hiện tại kèm status, chuyển màu vàng khi ticket đó quá hạn — bấm vào để mở ticket. Key từ branch chỉ được tin khi project của nó nằm trong số project bảng đã tải, nên `chore/node-22` không bị hiểu thành ticket NODE-22. Tắt bằng `codebrain.jira.statusBar`.

Trên mỗi card còn có **Ask CodeBrain** (mở Chat với ticket làm câu hỏi) và **Copy key** cho commit message. Nếu `codebrain.atlassian.allowWrite` đang bật, card có thêm **Move** để chuyển status — vẫn là đúng cái switch dành cho agent, nên khi chưa bật thì bảng chỉ đọc.

## 11. Tự động nhận diện ngôn ngữ

Chat participant phát hiện ngôn ngữ từ tin nhắn mới nhất.

Ví dụ:

```text
@codebrain /explain Giải thích workflow này
```

Kết quả được viết bằng tiếng Việt.

```text
@codebrain /explain Explain this authentication workflow
```

Kết quả được viết bằng tiếng Anh.

Tên function, API, identifier và đường dẫn file được giữ nguyên.

Với câu hỏi chỉ có tên symbol, extension sử dụng ngôn ngữ hiển thị của VS Code.

## 12. Cấu hình đề xuất

Thêm vào `.vscode/settings.json`:

```json
{
  "codebrain.autoRefresh.enabled": true,
  "codebrain.autoRefresh.debounceMs": 1000,
  "codebrain.chat.maxContextFiles": 12,
  "codebrain.chat.maxDiffCharacters": 120000,
  "codebrain.impact.maxDepth": 5,
  "codebrain.impact.detectDepthTruncation": true,
  "codebrain.codeLens.enabled": true,
  "codebrain.metrics.enabled": true,
  "codebrain.reports.openPreview": true,
  "codebrain.releaseNotes.showOnUpdate": true
}
```

`releaseNotes.showOnUpdate` mở trang **What's new** ở lần khởi động đầu tiên sau khi extension được cập nhật, gom đủ mọi bản phát hành kể từ version bạn đang dùng trước đó. Không hiện khi mới cài lần đầu, không hiện lại cho cùng một version. Mở thủ công bằng command **CodeBrain: What's New**.

Nếu dùng phần Collab + Jira, thêm (token **không** đặt ở đây — nhập qua command để lưu vào keychain):

```json
{
  "codebrain.atlassian.jiraUrl": "https://jira.example.com",
  "codebrain.atlassian.confluenceUrl": "https://collab.example.com",
  "codebrain.atlassian.maxResults": 10,
  "codebrain.atlassian.maxBodyCharacters": 12000,
  "codebrain.atlassian.maxImageBytes": 4194304,
  "codebrain.atlassian.allowWrite": false,
  "codebrain.atlassian.sslVerify": true
}
```

`allowWrite` là công tắc duy nhất quyết định agent có được sửa Jira/Confluence hay không. Nó áp dụng cho **mọi** agent đang dùng chung bộ credential này (Copilot, Claude Code, Codex, Gemini CLI, Antigravity), vì cờ này được ghi kèm vào `~/.codebrain/atlassian.env`.

## 13. Demo nhanh

Kịch bản demo đề xuất:

1. Mở một repository đã có source code.
2. Chạy **CodeBrain: Initialize Workspace**.
3. Thay đổi một function được nhiều nơi sử dụng.
4. Chạy **CodeBrain: Analyze Change Impact**.
5. Mở Workflow Graph và click vào các dependent nodes.
6. Kiểm tra danh sách affected tests.
7. Mở Token Savings Dashboard.
8. Chạy:

```text
@codebrain /review Đánh giá rủi ro release của thay đổi này
```

9. Export báo cáo Markdown.
10. Chuyển sang **CodeBrain Reviewer** để thực hiện review read-only.

## 14. Xử lý sự cố

### Workspace chưa có index

Chạy:

```text
CodeBrain: Initialize Workspace
```

### Index chưa cập nhật

Chạy:

```text
CodeBrain: Refresh Index
```

Trước mỗi lần phân tích, CodeBrain chỉ refresh khi workspace thật sự có thay đổi kể từ lần refresh trước — nên câu hỏi thứ hai liên tiếp sẽ nhanh hơn.

### Index bị thiếu file hoặc hỏng một phần

```text
CodeBrain: Show Index Status
```

Xem phần **Coverage gaps**. Nếu index bị báo là partial hoặc được build bởi engine cũ:

```text
CodeBrain: Rebuild Index
```

### Không tìm thấy affected tests

Kiểm tra:

- Test file có nằm trong repository không
- Tên test có dạng `.test.*`, `.spec.*`, `tests/`, `__tests__/` hoặc `e2e/`
- Dependency giữa source và test có thể được CodeBrain resolve không
- Index đã được refresh sau thay đổi chưa

### Chat không hoạt động

`/explain`, `/review` và `/impact` trong Chat cần một chat model đang được VS Code cung cấp. Các command index, Workflow Graph, affected-test detection, dashboard và export không phụ thuộc vào chat model.

### Copilot không thấy tool Jira/Confluence

Server Atlassian chỉ xuất hiện khi một sản phẩm đã cấu hình **đủ** base URL và token. Chạy **CodeBrain: Configure Atlassian (Collab + Jira)**, sau đó **CodeBrain: Test Atlassian Connection**.

### Claude Code / Codex / Gemini / Antigravity không thấy tool CodeBrain

Chạy **CodeBrain: Install CodeBrain for Agents** rồi restart agent — agent chỉ đọc danh sách MCP server lúc khởi động. Đăng ký theo phạm vi workspace chỉ có tác dụng trong đúng folder đó; muốn dùng ở mọi repo thì đăng ký global.

### Claude Code / Codex / Gemini / Antigravity không thấy tool Jira/Confluence

Chạy **CodeBrain: Register Atlassian MCP with Agents** rồi restart agent. Ghi chú về phạm vi ở trên cũng áp dụng ở đây.

### Token bị từ chối (401)

Token Server/Data Center xác thực dạng bearer, không cần username. API token của Cloud cần email tài khoản trong `codebrain.atlassian.username`. Token đã rotate thì chạy lại command configure.

### Confluence trả 404 với mọi request

URL Confluence Cloud phải có context path `/wiki`, ví dụ `https://site.atlassian.net/wiki`.

### Host Atlassian dùng CA nội bộ

Đặt `codebrain.atlassian.sslVerify` thành `false`, hoặc export `CODEBRAIN_ATLASSIAN_SSL_VERIFY=false` cho agent chạy ngoài VS Code.

### Runtime báo "permission denied" trên Linux/macOS

Không cần `chmod` thủ công nữa: khi khởi động, CodeBrain tự kiểm tra và cấp lại quyền thực thi cho runtime đi kèm (`runtime/<target>/node` và `runtime/<target>/bin/codegraph`) nếu trình cài đặt đã làm mất bit executable. Việc sửa được ghi vào Output channel **CodeBrain**.

Chỉ khi thư mục extension ở chế độ chỉ đọc hoặc thuộc user khác thì việc tự sửa mới thất bại — lúc đó thông báo lỗi in ra đúng câu lệnh `chmod +x` cần chạy.

### Runtime báo WASM fallback

VSIX đang cài có thể không đúng với platform/architecture của máy hoặc không chứa native kernel. Cài lại đúng package nền tảng. WASM fallback vẫn hoạt động nhưng không có tốc độ của native Rust kernel.

### Xem log

Mở:

```text
View → Output → CodeBrain
```

Sau đó chạy lại command gặp lỗi để xem stdout, stderr và exit code.

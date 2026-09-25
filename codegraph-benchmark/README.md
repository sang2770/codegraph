# Benchmark CodeGraph × Copilot CLI / Claude Code

Đo xem gắn CodeGraph MCP vào **GitHub Copilot CLI** hoặc **Claude Code** thay đổi **chi phí** (token, AI credits, số tool call, thời gian) và **chất lượng** (trả lời đúng, bắt được bug) thế nào, cho hai loại việc: **phân tích code** và **review code**.

Mỗi kịch bản chạy ở 2 arm, chỉ khác nhau đúng một điểm:

| | without | with |
|---|---|---|
| CodeGraph MCP | tắt (và cấm gọi lệnh `codegraph` qua shell) | bật (`codegraph serve --mcp --path <repo>`, daemon được khởi động sẵn) |
| Giống nhau | model, effort, prompt, commit của repo; tắt mọi MCP server khác; tắt instructions/hook/plugin toàn cục của người dùng; cấm ghi file; cấm truy cập mạng (web fetch, `gh`, `curl`, `wget`) để câu trả lời chỉ đến từ repo | ← |

Cách cô lập ở từng agent:

| | Copilot CLI | Claude Code |
|---|---|---|
| Gắn CodeGraph | `--additional-mcp-config` | `--strict-mcp-config --mcp-config` |
| Tắt MCP khác | `--disable-builtin-mcps` + `--disable-mcp-server <mỗi server trong ~/.copilot/mcp-config.json>` | `--strict-mcp-config` (bỏ qua mọi cấu hình MCP khác) |
| Tắt instructions / hook / plugin toàn cục | `--no-custom-instructions` | `--setting-sources project,local` (bỏ `~/.claude`: hook `codegraph prompt-hook`, plugin, `CLAUDE.md` toàn cục) + `--disable-slash-commands` |
| Cấm ghi file | `--deny-tool=write` | `--disallowedTools Edit Write NotebookEdit` |
| Arm without cấm `codegraph` qua shell | `--deny-tool='shell(codegraph)'` | `--disallowedTools 'Bash(codegraph:*)'` |
| Chi phí ghi nhận | AI credits (`totalNanoAiu`), premium requests | USD (`total_cost_usd`) |

Mọi run đều đặt `CODEGRAPH_NO_PROMPT_HOOK=1` để hook toàn cục (nếu có) không chèn thêm ngữ cảnh CodeGraph vào prompt.

## Kịch bản (24)

3 repo × (4 câu hỏi phân tích + 3 bug cài sẵn + 1 commit thật của upstream). Mỗi repo được ghim vào một commit cố định nên kết quả chạy lại được.

| Repo | Ngôn ngữ | File được index | Phân tích (`-a*`) | Review (`-r*`) |
|---|---|---|---|---|
| express | JavaScript | 148 | request → router → finalhandler · `res.json` → `send` · ảnh hưởng của `compileTrust` · `res.render` → `View` | off-by-one ở trust proxy (bảo mật) · bỏ escape `>` trong JSON (XSS) · đổi ETag mặc định weak→strong · commit `9a34acf` |
| flask | Python | 91 | `wsgi_app` → view → response · vòng đời session · ảnh hưởng của `make_response` · xử lý lỗi | cookie session mất `HttpOnly` · đảo thứ tự `after_request` · `should_set_cookie` or→and · commit `7203fea` |
| excalidraw | TypeScript/React | 702 | `mutateElement` → canvas render · undo · ảnh hưởng của `isElementInViewport` · reconcile khi collab | không xoá ShapeCache khi đổi width · `newElementWith` không tăng `version` · `triggerUpdate` bỏ `sceneNonce` · commit `31df3e6` |

Loại câu hỏi: `flow` (X đi đến Y thế nào), `impact` (đổi X thì cái gì hỏng), `architecture`, `seeded-*` (bug cài sẵn, có đáp án), `real-commit` (review diff thật).

Định nghĩa đầy đủ (prompt, bug, từ khoá chấm điểm) nằm trong [scenarios.json](scenarios.json).

## Chạy

```bash
cd codegraph-benchmark

# 1. Kiểm tra miễn phí (không tốn credit): tool, clone + index repo, áp dụng 24 kịch bản,
#    bắt tay với MCP, in lệnh của từng agent/arm
./preflight.sh                    # kiểm tra cả hai agent
AGENTS=claude ./preflight.sh      # chỉ Claude Code

# 2. Chạy thử 1 cặp để xem mức tiêu hao:  run.sh <copilot|claude> <kịch-bản> <with|without>
./run.sh copilot ex-a1-request-flow without
./run.sh copilot ex-a1-request-flow with
./run.sh claude  ex-a1-request-flow without
./run.sh claude  ex-a1-request-flow with

# 3. Chạy một phần, rồi toàn bộ (mặc định AGENTS=copilot)
./run-matrix.sh '^ex-'                          # Copilot, chỉ express: 8 × 2 arm × 2 lần = 32 run
AGENTS=claude ./run-matrix.sh '^ex-'            # Claude Code, chỉ express: 32 run
AGENTS="copilot claude" ./run-matrix.sh '^ex-'  # cả hai, so sánh cạnh nhau: 64 run
./run-matrix.sh -- '-a[0-9]-'                   # chỉ phân tích
./run-matrix.sh -- '-r[0-9]-'                   # chỉ review
AGENTS="copilot claude" ./run-matrix.sh         # toàn bộ: 24 × 2 arm × 2 lần × 2 agent = 192 run
```

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AGENTS` | `copilot` | `copilot`, `claude`, hoặc `"copilot claude"` |
| `RUNS` | `2` | số lần lặp mỗi kịch bản mỗi arm (≥2; biến động giữa các lần chạy lớn) |
| `MODEL` / `EFFORT` | `claude-sonnet-5` / `high` | xem [Chọn MODEL và EFFORT](#chọn-model-và-effort) |
| `RUN_TIMEOUT` | `900` | giây tối đa mỗi run |
| `MAX_CREDITS` | – | Copilot: giới hạn AI credits mỗi run (`--max-ai-credits`) |
| `MAX_USD` | `3` | Claude Code: giới hạn USD mỗi run (`--max-budget-usd`) |
| `CG_BIN` | `codegraph` trên PATH | build CodeGraph cần đo; `bin/codegraph-dev` = bản `dist/` của repo này (`npm run build`) |
| `CLAUDE_BIN` | `claude` trên PATH, nếu không có thì lấy binary mới nhất của extension VS Code | binary Claude Code |
| `CG_PROFILE` | – | `CODEGRAPH_MCP_PROFILE` cho arm with; `review` để agent thấy thêm `codegraph_review` (cần CodeGraph ≥ 1.6, ví dụ `CG_BIN=bin/codegraph-dev`) |
| `ENABLE_TOOL_SEARCH` | (mặc định của Claude Code) | `false` = Claude Code nạp đầy đủ mô tả tool MCP ngay từ đầu, thay vì chỉ thấy tên tool cho tới khi gọi `ToolSearch` |
| `SCENARIOS` | `scenarios.json` | file kịch bản (dùng cho project thật) |
| `CORPUS_DIR` | `/tmp/codegraph-corpus` | nơi clone các repo |
| `DRY_RUN=1` | – | chỉ in lệnh của agent, không chạy |

Mỗi run Copilot tốn ít nhất 1 premium request cộng với AI credits theo lượng token; mỗi run Claude Code tốn USD theo token (bị chặn ở `MAX_USD`). Nên chạy bước 2 trước để ước lượng chi phí trước khi chạy cả ma trận.

## Kết quả

Mỗi lần `run-matrix.sh` tạo ra `results/<thời-điểm>/`:

- `report.md` — báo cáo để chia sẻ: nếu có nhiều agent thì có bảng so sánh nhanh giữa các agent; sau đó mỗi agent có một mục riêng với bảng thay đổi with so với without cho **Phân tích / Review / Tổng**, rồi bảng chi tiết từng kịch bản.
- `runs.csv`, `scenarios.csv` — số liệu thô để đưa vào Excel/Sheets.
- `<agent>__<id>__<arm>__<n>.answer.md` — câu trả lời cuối của agent, để đọc kiểm tra.
- `<agent>__<id>__<arm>__<n>.stdout.jsonl` (và `.events.jsonl` với Copilot) — log đầy đủ của run (từng tool call, token).

Tạo lại báo cáo từ một thư mục có sẵn: `node lib/summarize.mjs results/<thời-điểm>`.

### Các chỉ số

| Chỉ số | Lấy từ đâu |
|---|---|
| Thời gian | thời gian thực của cả run |
| Tool calls / Đọc / Tìm | Copilot: sự kiện `tool.execution_start`; Claude: các khối `tool_use` (gồm cả của subagent). "Đọc" = `view`/`Read` + `cat`/`head`/`sed -n` qua shell; "tìm" = `rg`/`glob`/`Grep`/`Glob` + `grep`/`find` qua shell |
| Input / output tokens | Copilot: `session.shutdown` → `modelMetrics`; Claude: `result.modelUsage`. Ở **cả hai**, input **đã bao gồm** token đọc/ghi cache |
| Chi phí | Copilot: `totalNanoAiu / 1e9` AI credits + `totalPremiumRequests`; Claude: `total_cost_usd` |
| MCP đã kết nối? | Copilot: sự kiện `mcp_server_status_changed`; Claude: `mcp_servers` trong sự kiện `init` |
| Điểm chất lượng | tỉ lệ nhóm từ khoá kỳ vọng xuất hiện trong câu trả lời cuối |
| Bắt bug | câu trả lời nêu đúng chỗ **và** bản chất của bug cài sẵn |

Số tổng hợp = trung vị trên các kịch bản của tỉ lệ with/without, nên mỗi kịch bản có trọng số như nhau. Báo cáo cũng ghi khoảng min…max.

### Báo cáo tự đánh dấu những run không đáng tin

- run không hoàn thành / timeout / agent đã sửa file → bị loại khỏi thống kê;
- run ở arm "with" mà MCP CodeGraph không kết nối được → liệt kê riêng;
- run ở arm "with" có CodeGraph nhưng agent không gọi lần nào → liệt kê riêng.

Chi phí tuyệt đối **không** so sánh trực tiếp được giữa hai agent (USD và AI credits là hai đơn vị khác nhau, và system prompt/tool của hai agent cũng khác). Hãy so sánh **mức thay đổi %** mà CodeGraph tạo ra trong từng agent.

## Giới hạn cần nói rõ khi báo cáo

- **Điểm chất lượng là heuristic dựa trên từ khoá.** Nó cho biết câu trả lời có nhắc đúng symbol hay không, chứ không chứng minh lời giải thích là đúng. Hãy đọc kiểm tra một phần file `*.answer.md`, nhất là các kịch bản review `real-commit` (loại này không có đáp án chuẩn).
- **n nhỏ.** Với `RUNS=2`, hãy báo cáo khoảng giá trị chứ không báo cáo một con số đơn lẻ. Nếu cần kết luận chắc hơn thì tăng `RUNS`.
- **Kết quả đo trên 3 repo mã nguồn mở.** Để có con số cho code của team, hãy thêm repo của team (xem dưới).

## Chạy trên project thực tế

Benchmark **không bao giờ đụng vào working copy của bạn**. Nó clone repo (chỉ phần đã commit) vào `CORPUS_DIR`, rồi reset / cài bug / áp diff trên bản clone đó.

**1. Tạo file kịch bản cho project**

```bash
cd codegraph-benchmark
node lib/init-project.mjs ~/work/my-service myservice              # repo local
node lib/init-project.mjs https://git.company/team/my-service.git  # hoặc URL git
```

Lệnh trên tạo `scenarios.myservice.json` gồm:
- repo ghim ở commit `HEAD` hiện tại, kèm số file code;
- **3 kịch bản review commit thật**: lấy các commit fix/feat gần đây, sửa 10–400 dòng code, bỏ qua commit chore/docs/test. Loại này không cần đáp án;
- **3 khung câu hỏi phân tích** (`flow`, `impact`, `architecture`) còn `TODO`.

Thêm `--commits 5` nếu muốn lấy nhiều commit hơn.

**2. Điền các `TODO`.** Đây là bước quan trọng nhất, vì câu hỏi phải là **câu dev trong team thật sự hay hỏi**.

| Loại | Câu hỏi mẫu | `expect` = tên hàm/class mà câu trả lời đúng **phải** nhắc tới |
|---|---|---|
| flow | "Request `POST /orders` đi tới lúc ghi DB qua những hàm nào?" | `[["OrderController"], ["createOrder"], ["OrderRepository", "save"]]` |
| impact | "Nếu đổi `calculatePrice` thì những chỗ nào bị ảnh hưởng?" | các caller chính của hàm |
| architecture | "Module thanh toán hoạt động thế nào?" | các class chính của module |

- Mỗi nhóm là một danh sách **các cách viết thay thế**: câu trả lời chỉ cần chứa **một** trong số đó là nhóm đạt.
- Nên chọn câu hỏi mà đáp án **nằm rải rác trên nhiều file**. Câu hỏi chỉ cần đọc 1 file thì CodeGraph không có gì để giúp.
- Có thể thêm review có bug cài sẵn: `seed: [{file, find, replace}]`, trong đó `find` phải khớp **đúng 1 lần** trong file, kèm `detect` là các từ chứng minh agent đã bắt được bug. Nên chọn bug mà tác động **lan sang code khác**; diff 1 dòng tự giải thích thì agent không cần tra thêm ngữ cảnh.
- Kiểm tra lại `expect` của các kịch bản review commit thật: script tự sinh chúng từ tên file bị sửa, nên đó chỉ là gợi ý thô.

**3. Kiểm tra miễn phí**

```bash
SCENARIOS=scenarios.myservice.json AGENTS=claude ./preflight.sh
```

Preflight báo lỗi nếu còn `TODO`, nếu seed không khớp, hoặc nếu CodeGraph index được **ít hơn một nửa** số file code, tức là ngôn ngữ của project có thể chưa được hỗ trợ.

**4. Chạy từ nhỏ đến lớn**

```bash
export SCENARIOS=scenarios.myservice.json
AGENTS=claude RUNS=1 ./run-matrix.sh 'a1-flow|r1-'                # 4 run: xem chi phí
AGENTS=claude RUNS=2 ./run-matrix.sh                              # 6 kịch bản × 2 arm × 2 lần = 24 run
AGENTS="copilot claude" RUNS=2 ./run-matrix.sh                    # cả hai agent: 48 run
```

**Lưu ý với code nội bộ**
- Code được gửi tới nhà cung cấp model, giống hệt khi bạn dùng agent bình thường. Hãy chạy trong đúng môi trường và tài khoản được phép dùng với repo đó.
- `results/` chứa các đoạn code trích ra và câu trả lời của agent. Đừng chia sẻ thư mục này ra ngoài team; chỉ nên gửi `report.md` sau khi đã đọc lại.
- Nếu `claude` dùng tài khoản gói Pro/Max, các run sẽ trừ vào **cùng hạn mức** với phiên làm việc hằng ngày của bạn. Có thể dùng `ANTHROPIC_API_KEY` riêng, hoặc chạy ngoài giờ.

## Cấu trúc

```
codegraph-benchmark/
├── scenarios.json      24 kịch bản + repo ghim theo commit (đổi file bằng SCENARIOS=…)
├── preflight.sh        kiểm tra miễn phí trước khi chạy
├── run.sh              1 run: <copilot|claude> <scenario> <with|without> [n]
├── run-matrix.sh       nhiều kịch bản × AGENTS × 2 arm × RUNS, rồi viết báo cáo
└── lib/
    ├── init-project.mjs  tạo scenarios.<tên>.json cho project thật
    ├── prepare.mjs     đưa repo về đúng trạng thái kịch bản (commit, seed, diff) + sync index
    ├── parse.mjs       log của Copilot hoặc Claude → 1 dòng metrics + chấm điểm
    └── summarize.mjs   results.jsonl → report.md + CSV
```

## Chọn MODEL và EFFORT

Cú pháp: đặt biến môi trường ngay trước lệnh, không cần `export`, và không cần ngoặc kép nếu giá trị không có khoảng trắng.

```bash
MODEL=claude-sonnet-5 EFFORT=high ./run.sh claude ex-a1-request-flow with
MODEL=claude-sonnet-5 EFFORT=medium RUNS=3 ./run-matrix.sh '^ex-'
AGENTS="copilot claude" MODEL=claude-sonnet-5 ./run-matrix.sh     # cùng một model cho cả hai agent
```

| | Copilot CLI | Claude Code |
|---|---|---|
| `MODEL` nhận | ID model của Copilot, ví dụ `claude-sonnet-5`, `claude-opus-5`, `gpt-5.6-luna` (danh sách đầy đủ: `copilot help config`) | alias `sonnet` / `opus` / `fable` hoặc ID đầy đủ, ví dụ `claude-sonnet-5` |
| `EFFORT` nhận | `none` `minimal` `low` `medium` `high` `xhigh` `max` | `low` `medium` `high` `xhigh` `max` |

- Mặc định `MODEL=claude-sonnet-5` vì **cả hai agent đều nhận ID này**. Nhờ vậy khi chạy `AGENTS="copilot claude"`, hai agent dùng cùng một model, và phần chênh lệch còn lại chỉ đến từ agent.
- Không dùng alias `sonnet` khi chạy cả hai agent: Copilot không hiểu alias này.
- Sonnet là model "sàn" có chủ đích: một cải thiện thấy được trên Sonnet thì thường cũng thấy trên model mạnh hơn, còn điều ngược lại thì không chắc. Hãy giữ nguyên `MODEL`/`EFFORT` trong suốt một lần so sánh.
- `EFFORT` cao hơn nghĩa là model suy luận nhiều hơn: tốn token/thời gian hơn và có thể tốn nhiều tool call hơn. Nó **không** đổi timeout (`RUN_TIMEOUT`) hay giới hạn chi phí (`MAX_USD`, `MAX_CREDITS`); nếu run bị cắt ngang thì hãy tăng các biến đó.

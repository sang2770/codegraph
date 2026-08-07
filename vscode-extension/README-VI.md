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

## 8. Token Saving Dashboard

Mở:

```text
CodeBrain: Token Savings Dashboard
```

Dashboard hiển thị:

- Số lần phân tích
- Context token từ CodeBrain
- Baseline đọc file
- Token tiết kiệm
- Số lượt đọc file tránh được
- Độ trễ lần phân tích gần nhất

Các số token là **ước tính**, không phải dữ liệu billing của model.

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

## 10. Export báo cáo

Sau khi chạy `/explain`, `/review` hoặc `/impact`, dùng:

```text
CodeBrain: Export Latest Report as Markdown
```

Markdown giữ nguyên heading, tables, code blocks và Mermaid chart. File nhẹ, có thể preview trực tiếp trong VS Code, đọc lại bằng AI và review bằng Git diff.

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
  "codebrain.metrics.enabled": true,
  "codebrain.reports.openPreview": true
}
```

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

### Không tìm thấy affected tests

Kiểm tra:

- Test file có nằm trong repository không
- Tên test có dạng `.test.*`, `.spec.*`, `tests/`, `__tests__/` hoặc `e2e/`
- Dependency giữa source và test có thể được CodeBrain resolve không
- Index đã được refresh sau thay đổi chưa

### Chat không hoạt động

`/explain`, `/review` và `/impact` trong Chat cần một chat model đang được VS Code cung cấp. Các command index, Workflow Graph, affected-test detection, dashboard và export không phụ thuộc vào chat model.

### Runtime báo WASM fallback

VSIX đang cài có thể không đúng với platform/architecture của máy hoặc không chứa native kernel. Cài lại đúng package nền tảng. WASM fallback vẫn hoạt động nhưng không có tốc độ của native Rust kernel.

### Xem log

Mở:

```text
View → Output → CodeBrain
```

Sau đó chạy lại command gặp lỗi để xem stdout, stderr và exit code.

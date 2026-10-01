# Kế Hoạch Phát Triển & Nâng Cấp Extension CodeBrain LGE
*(CodeBrain Next-Gen: Actionable Agent & Executive Metrics Framework)*

---

## I. Mục Tiêu Chiến Lược
1. **Tối ưu hóa quy trình Dev (Developer Velocity & UX)**:
   - Chuyển từ mô hình **Chatbot hỗ trợ thụ động (Read-only / Planning)** sang **Vòng lặp tự động hóa (Actionable & Closed-Loop)**: Lập kế hoạch $\rightarrow$ Sửa code 1-Click $\rightarrow$ Sinh test $\rightarrow$ Kiểm tra chẩn đoán (Diagnostics) $\rightarrow$ Hoàn tất.
2. **Minh bạch hóa giá trị & Đo lường ROI cho Quản lý (Management Metrics)**:
   - Tận dụng dữ liệu tất định từ `MetricsStore` để xuất báo cáo định lượng (Token Savings, Giờ công tiết kiệm, Giảm thiểu bug) phục vụ review chỉ số với sếp / ban giám đốc.

---

## II. Phân Tích Hiện Trạng & Khoảng Trống (Gap Analysis)

| Thành phần | Hiện tại | Khoảng trống cần giải quyết | Giải pháp đề xuất |
| :--- | :--- | :--- | :--- |
| **Command `/fix` & `/implement`** | Sinh báo cáo phân tích + markdown handoff prompt | Dev phải copy-paste code thủ công hoặc gọi agent ngoài | Nút **1-Click Apply Code & Inline Diff** |
| **Kiểm thử (Testing)** | Có tính năng phát hiện `affectedTests` | Chưa có công cụ tự động sinh test case cho các caller bị ảnh hưởng | Bổ sung Chat Command **`/test`** |
| **Tạo Pull Request** | Dev phải tự viết mô tả PR và tra cứu thủ công | Thiếu liên kết tự động giữa Git diff, Jira AC và blast radius | Bổ sung Chat Command **`/pr`** |
| **Trải nghiệm trên Editor** | Phải mở Chat Panel mới thấy phân tích | Không thấy rủi ro trực tiếp khi đang gõ code | **CodeLens Impact & Quick Run Tests** |
| **Báo cáo cho Quản lý** | Dữ liệu lưu trong `workspaceState` (Webview Impact) | Chưa có công cụ xuất báo cáo tổng quan (Executive Summary) | Lệnh **Export Executive ROI Report (MD/HTML/PDF)** |
| **Mở rộng hệ sinh thái** | Tool `codebrain_explore` chỉ dùng nội bộ | Các agent khác trong VS Code (Copilot gốc, Claude) không gọi được | Đăng ký chuẩn **`vscode.lm.registerTool`** |

---

## III. Lộ Trình Triển Khai Chi Tiết (Implementation Roadmap)

### Giai đoạn 1: Quick Wins - 1-Click Action & Báo Cáo Đo Lường (2 - 3 Tuần)

#### 1. Tính năng "1-Click Apply Code Proposal & Inline Diff"
- **Mục tiêu**: Cho phép lập trình viên áp dụng trực tiếp các đoạn code được đề xuất từ `/fix` hoặc `/implement` vào workspace.
- **Nhiệm vụ cụ thể**:
  - [x] Xây dựng parser bóc tách file path và nội dung code từ các code blocks trong Chat Response.
  - [x] Đăng ký command `codebrain.applyCodeProposal` sử dụng `vscode.workspace.applyEdit`.
  - [x] Tích hợp giao diện Preview Diff trước khi ghi đè để lập trình viên kiểm tra an toàn.
  - [x] Hiển thị nút bấm `Apply to Workspace` ngay dưới message của `/fix` và `/implement`.

#### 2. Tính năng "Export Executive ROI Report" (Báo cáo nộp Sếp)
- **Mục tiêu**: Trực quan hóa và xuất dữ liệu hiệu quả công việc từ `MetricsStore`.
- **Nhiệm vụ cụ thể**:
  - [x] Đăng ký command `codebrain.exportExecutiveReport`.
  - [x] Thu thập các trường dữ liệu thực tế:
    - Tổng token tiết kiệm (`totalTokensSaved`), tỷ lệ tiết kiệm so với baseline (`savingsPercent`).
    - Số lượt phân tích (`analyses`), số lượt tránh đọc toàn bộ file (`totalFileReadsAvoided`).
    - Thời gian tiết kiệm ước tính khi chạy Affected Tests so với Full Suite.
  - [x] Định dạng báo cáo Markdown/HTML chuyên nghiệp gồm:
    - Executive Summary (Tóm tắt cho quản lý cấp cao).
    - Biểu đồ và bảng thống kê chi tiết theo tuần/tháng.
    - Quy đổi thời gian kỹ sư tiết kiệm được ra giờ công ($h$).

---

### Giai đoạn 2: Bổ Sung Chat Commands Thiết Thực (2 - 3 Tuần)

#### 1. Command `/test` (Affected Test Generator)
- **Mục tiêu**: Tự động sinh unit test cho các hàm bị thay đổi hoặc các hàm phụ thuộc (callers) có nguy cơ vỡ logic.
- **Nhiệm vụ cụ thể**:
  - [x] Đăng ký command `test` trong `chatParticipants` (`package.json`).
  - [x] Xây dựng prompt system `TEST_INSTRUCTIONS`:
    - Đọc diff Git và các nodes bị ảnh hưởng thông qua CodeGraph.
    - Nhận diện framework test của dự án (Jest, Vitest, PyTest, JUnit, Go testing...).
    - Sinh mã kiểm thử kèm mock cho các dependency bên ngoài.
  - [x] Hỗ trợ nút `Create Test File` hoặc `Run This Test` trực tiếp từ chat.

#### 2. Command `/pr` (Smart PR Creator)
- **Mục tiêu**: Chuẩn hóa nội dung Pull Request dựa trên Jira Ticket và phân tích Impact của CodeGraph.
- **Nhiệm vụ cụ thể**:
  - [x] Đăng ký command `pr` trong `chatParticipants`.
  - [x] Thu thập ngữ cảnh tự động:
    - Jira Ticket (Summary, Acceptance Criteria).
    - Git diff & danh sách commit.
    - Blast Radius & Danh sách các Affected Tests đã pass.
  - [x] Sinh template PR hoàn chỉnh:
    - Mô tả thay đổi nghiệp vụ.
    - Bảng đối soát Acceptance Criteria (`Met` / `Partial` / `Missing`).
    - Checklist kiểm tra an toàn và phân tích rủi ro.
  - [x] Nút bấm `Copy PR Description` hoặc hỗ trợ tạo PR trực tiếp nếu có Git extension đi kèm.

---

### Giai đoạn 3: Tối Ưu Hóa Trải Nghiệm & Mở Rộng Hệ Sinh Thái (3 - 4 Tuần)

#### 1. CodeLens "Change Impact & Quick Test" trên Editor
- **Mục tiêu**: Cảnh báo rủi ro tức thì cho dev ngay khi đang gõ code.
- **Nhiệm vụ cụ thể**:
  - [x] Tạo `CodeLensProvider` gắn vào các file được theo dõi trong Git working tree.
  - [x] Hiển thị thông tin tại đầu hàm: `$(type-hierarchy-sub) X callers | $(play) Run affected tests`.
  - [x] Bấm vào để kích hoạt nhanh `codebrain.analyzeImpact` hoặc `codebrain.runAffectedTests`.

#### 2. Đăng ký VS Code Language Model Tools API (`vscode.lm.registerTool`)
- **Mục tiêu**: Cho phép GitHub Copilot Chat hoặc Claude Code trong VS Code gọi được CodeBrain làm context provider.
- **Nhiệm vụ cụ thể**:
  - [x] Khai báo contribution point `languageModelTools` trong `package.json`.
  - [x] Đăng ký các công cụ:
    - `codebrain_get_impact`: Lấy danh sách hàm/file bị ảnh hưởng bởi thay đổi.
    - `codebrain_get_affected_tests`: Lấy danh sách file test liên quan.
    - `codebrain_explore_symbol`: Lấy mã nguồn kèm định vị dòng chính xác.

---

## IV. Khung Đo Lường & Báo Cáo Hiệu Quả (Executive Metrics & Benchmark)

Khi review với cấp trên, báo cáo sẽ dựa trên 4 trụ cột cốt lõi:

### 1. Trụ cột Tiết kiệm Chi phí & Tài nguyên AI
- **Chỉ số (KPI)**:
  - `% Token Tiết kiệm`: $\frac{\text{Baseline Tokens} - \text{Context Tokens}}{\text{Baseline Tokens}} \times 100\%$ (Kỳ vọng: $40\% - 60\%$).
  - `Số lượt Tool Calls`: Giảm từ 10–15 lượt (mò mẫm) xuống 1–3 lượt nhờ CodeGraph.

### 2. Trụ cột Tốc độ Phát triển (Developer Velocity - DORA / SPACE)
- **Chỉ số (KPI)**:
  - `Thời gian chạy Test Cục bộ (Cycle Time)`: Giảm $75\% - 90\%$ nhờ tính năng chạy test theo vùng ảnh hưởng thay vì chạy toàn bộ test suite.
  - `Thời gian Onboarding / Đọc hiểu Code`: Giảm $50\%$ thời gian tìm hiểu luồng nghiệp vụ nhờ `/explain` và sơ đồ Mermaid chuẩn xác.

### 3. Trụ cột Chất lượng Phần mềm (Quality & Risk Mitigation)
- **Chỉ số (KPI)**:
  - `Acceptance Criteria Coverage`: Đạt $100\%$ tiêu chí nghiệm thu của Jira trước khi submit PR.
  - `Tỷ lệ lỗi hồi quy (Regression Rate)`: Giảm thiểu nhờ ma trận rủi ro cảnh báo sớm các hàm phụ thuộc (callers) bị ảnh hưởng.

### 4. Mẫu Bảng Quy Đổi Giá Trị Hàng Tháng (Dành cho Quản lý)

| Chỉ số đo lường | Trước khi dùng Extension | Khi dùng Extension | Lợi ích quy đổi (Đội ngũ 10 Devs / Tháng) |
| :--- | :--- | :--- | :--- |
| **Thời gian chờ chạy test** | Chạy full test suite (~20 phút/lần) | Chạy Affected Tests (~1 phút/lần) | **Tiết kiệm ~120 giờ chờ đợi** |
| **Thời gian Review PR** | Đọc thủ công và suy đoán rủi ro (~45 phút/PR) | Báo cáo `/review` chỉ rõ Blast Radius (~10 phút/PR) | **Tiết kiệm ~70 giờ review** |
| **Thời gian Debug & Fix** | Mò mẫm log và call stack (~2 giờ/bug) | `/fix` trace thẳng đến file:line root cause (~20 phút) | **Tiết kiệm ~50 giờ điều tra** |
| **Chi phí Token AI** | Nạp toàn bộ file dung lượng lớn | Chỉ nạp lát cắt đồ thị chính xác | **Giảm 50% chi phí AI Token** |
| **TỔNG LỢI ÍCH** | — | — | **~240 giờ kỹ sư/tháng** (~1.5 nhân sự) |

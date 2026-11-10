// Hồ sơ mẫu bổ sung cho màn "Thư viện" > "Danh sách hồ sơ đã phê duyệt"
// (archive công khai toàn hệ thống, không riêng người đang xem).
// Tất cả đều status: 'completed', qualified: true - minh họa hồ sơ đã hoàn tất, đạt.
// Mã hồ sơ không trùng với prototype/shared/record-samples.js hay prototype/ho-so-cua-toi/records-data.js.
// File này PHẢI nạp SAU prototype/shared/record-samples.js (đúng thứ tự script đã dùng ở mọi
// trang hiện có). window.RECORD_SAMPLES_LIBRARY giữ riêng 6 hồ sơ mới, rồi gộp thẳng vào
// window.RECORD_SAMPLES ngay dưới - trang nào không nạp file này vẫn chạy đúng như cũ.
window.RECORD_SAMPLES_LIBRARY = {
  'YT-2026-0033': {
    id: 'YT-2026-0033', type: 'idea', title: 'Mẫu biên bản kiểm tra an toàn trước chuyến bay dùng QR code',
    description: 'Hiện trạng: biên bản kiểm tra an toàn trước chuyến bay ghi tay trên giấy, khó tra cứu lại.\nGiá trị đem lại: tra cứu nhanh lịch sử kiểm tra qua mã QR dán tại vị trí kiểm tra.\nThời gian triển khai: thực hiện ngay khi được phê duyệt.\nSự tham gia CQ/ĐV: nội bộ Ban An toàn - Chất lượng tự thực hiện.\nChi phí: không phát sinh chi phí.',
    areas: ['An toàn an ninh'],
    cover: null, files: [],
    authors: [{ id: 'u21', percent: 100 }],
    participants: [],
    manager: 'u21', followers: [],
    onBehalf: false,
    status: 'completed', level: 1, target: null,
    qualified: true, closedAt: '18/02/2026',
    expertReviewPending: false, expertRequests: [],
    history: [
      { at: '02/01/2026 08:00', who: 'u21', action: 'lưu nháp hồ sơ' },
      { at: '02/01/2026 09:00', who: 'u21', action: 'gửi hồ sơ' },
      { at: '05/01/2026 10:00', who: 'u21', action: 'chấm điểm, không chuyển cấp' },
      { at: '18/02/2026 14:00', who: 'u21', action: 'nhập số tiền đã chi, giải ngân' },
    ],
    scores: [
      { level: 1, roleLabel: 'CBQL trực tiếp', by: 'u21', total: 75, note: 'Dễ triển khai, chi phí thấp.', breakdown: { urgency: 25, benefit: 20, timeline: 10, participation: 10, cost: 10 } },
    ],
    reward: { amount: '400.000 đ', level: 'CBQL trực tiếp', scoreTier: '70 - <90' },
  },

  'GP-2026-0022': {
    id: 'GP-2026-0022', type: 'solution', title: 'Ứng dụng di động báo cáo sự cố mặt đất theo thời gian thực',
    content: 'Xây dựng ứng dụng di động cho nhân viên mặt đất báo cáo sự cố ngay tại vị trí phát sinh, kèm ảnh chụp và định vị, gửi thẳng về trung tâm điều hành.',
    areas: ['Khai thác bay', 'CĐS - CNTT'],
    cost: '90000000', novelty: 'Hiện báo cáo sự cố mặt đất qua điện thoại hoặc giấy, chậm và dễ thiếu thông tin.', benefit: 'Giảm thời gian xử lý sự cố, có đầy đủ hình ảnh và vị trí ngay khi báo cáo.',
    trialDate: '2026-03-01', other: '',
    cover: null, files: [{ name: 'de-xuat-ung-dung-bao-cao-su-co.pdf', size: 310000 }],
    authors: [{ id: 'u6', percent: 100 }],
    participants: [{ id: 'u20', task: 'Thử nghiệm ứng dụng tại đội mặt đất' }],
    manager: 'u1', followers: [],
    onBehalf: false,
    status: 'completed', level: 2, target: null,
    qualified: true, closedAt: '22/03/2026',
    expertReviewPending: false, expertRequests: [],
    history: [
      { at: '10/01/2026 08:00', who: 'u6', action: 'lưu nháp hồ sơ' },
      { at: '10/01/2026 09:00', who: 'u6', action: 'gửi hồ sơ' },
      { at: '12/01/2026 10:00', who: 'u1', action: 'chấm điểm' },
      { at: '12/01/2026 10:05', who: 'u1', action: 'chuyển cấp' },
      { at: '20/01/2026 11:00', who: 'u11', action: 'chấm điểm, không chuyển cấp' },
      { at: '22/03/2026 15:00', who: 'u11', action: 'nhập số tiền đã chi, giải ngân' },
    ],
    scores: [
      { level: 1, roleLabel: 'CBQL trực tiếp', by: 'u1', total: 78, note: 'Khả thi, nên thử nghiệm sớm.', breakdown: { scope: 7, benefit: 56, convenience: 15 } },
      { level: 2, roleLabel: 'Trưởng CQĐV', by: 'u11', total: 83, note: 'Chấm điểm chốt, dừng ở cấp CQĐV.', breakdown: { scope: 7, benefit: 61, convenience: 15 } },
    ],
    reward: { amount: '5.000.000 đ', level: 'Trưởng CQ/ĐV', scoreTier: '70 - <90' },
  },

  'YT-2026-0044': {
    id: 'YT-2026-0044', type: 'idea', title: 'Chuẩn hóa mẫu đánh giá huấn luyện định kỳ cho giáo viên bay',
    description: 'Hiện trạng: mỗi giáo viên huấn luyện dùng mẫu đánh giá khác nhau, khó tổng hợp so sánh.\nGiá trị đem lại: thống nhất 1 mẫu đánh giá chung, dễ tổng hợp và lưu trữ.\nThời gian triển khai: thực hiện ngay khi được phê duyệt.\nSự tham gia CQ/ĐV: nội bộ Trung tâm huấn luyện bay tự thực hiện.\nChi phí: không phát sinh chi phí.',
    areas: ['Khai thác bay'],
    cover: null, files: [],
    authors: [{ id: 'u9', percent: 100 }],
    participants: [],
    manager: 'u9', followers: [],
    onBehalf: false,
    status: 'completed', level: 1, target: null,
    qualified: true, closedAt: '30/01/2026',
    expertReviewPending: false, expertRequests: [],
    history: [
      { at: '15/12/2025 08:00', who: 'u9', action: 'lưu nháp hồ sơ' },
      { at: '15/12/2025 09:00', who: 'u9', action: 'gửi hồ sơ' },
      { at: '18/12/2025 10:00', who: 'u9', action: 'chấm điểm, không chuyển cấp' },
      { at: '30/01/2026 14:00', who: 'u9', action: 'nhập số tiền đã chi, giải ngân' },
    ],
    scores: [
      { level: 1, roleLabel: 'CBQL trực tiếp', by: 'u9', total: 72, note: 'Hữu ích cho công tác huấn luyện.', breakdown: { urgency: 20, benefit: 22, timeline: 10, participation: 10, cost: 10 } },
    ],
    reward: { amount: '400.000 đ', level: 'CBQL trực tiếp', scoreTier: '70 - <90' },
  },

  'GP-2026-0051': {
    id: 'GP-2026-0051', type: 'solution', title: 'Nền tảng dữ liệu dùng chung cho các khối nghiệp vụ',
    content: 'Xây dựng nền tảng lưu trữ và chia sẻ dữ liệu dùng chung giữa các khối nghiệp vụ, thay thế việc trao đổi file rời rạc qua email.',
    areas: ['CĐS - CNTT', 'Quản lý chung'],
    cost: '350000000', novelty: 'Hiện các khối lưu dữ liệu riêng lẻ, khó tra cứu và dễ sai lệch phiên bản.', benefit: 'Giảm thời gian tra cứu dữ liệu liên khối, tránh sai lệch phiên bản tài liệu.',
    trialDate: '2026-04-01', other: '',
    cover: null, files: [{ name: 'kien-truc-nen-tang-du-lieu.pdf', size: 540000 }],
    authors: [{ id: 'u10', percent: 60 }, { id: 'u25', percent: 40 }],
    participants: [],
    manager: 'u26', followers: [],
    onBehalf: false,
    status: 'completed', level: 3, target: null,
    qualified: true, closedAt: '10/05/2026',
    expertReviewPending: false, expertRequests: [],
    history: [
      { at: '05/02/2026 08:00', who: 'u10', action: 'lưu nháp hồ sơ' },
      { at: '05/02/2026 09:00', who: 'u10', action: 'gửi hồ sơ' },
      { at: '08/02/2026 10:00', who: 'u26', action: 'chấm điểm' },
      { at: '08/02/2026 10:05', who: 'u26', action: 'chuyển cấp' },
      { at: '15/02/2026 11:00', who: 'u25', action: 'chấm điểm' },
      { at: '15/02/2026 11:05', who: 'u25', action: 'chuyển cấp' },
      { at: '01/03/2026 09:00', who: 'u25', action: 'chấm điểm, không chuyển cấp' },
      { at: '10/05/2026 15:00', who: 'u25', action: 'nhập số tiền đã chi, giải ngân' },
    ],
    scores: [
      { level: 1, roleLabel: 'CBQL trực tiếp', by: 'u26', total: 80, note: 'Cần thiết cho chuyển đổi số.', breakdown: { scope: 8, benefit: 57, convenience: 15 } },
      { level: 2, roleLabel: 'Trưởng CQĐV', by: 'u25', total: 85, note: 'Nên nhân rộng ra toàn Khối.', breakdown: { scope: 9, benefit: 61, convenience: 15 } },
      { level: 3, roleLabel: 'PTGĐ (Khối/lĩnh vực)', by: 'u25', total: 88, note: 'Chấm điểm chốt, nền tảng tốt cho các dự án số hóa tiếp theo.', breakdown: { scope: 10, benefit: 63, convenience: 15 } },
    ],
    reward: { amount: '11.000.000 đ', level: 'Giám đốc Khối/lĩnh vực', scoreTier: '70 - <90' },
  },

  'YT-2026-0066': {
    id: 'YT-2026-0066', type: 'idea', title: 'Bảng chỉ số đúng giờ theo khối cho lãnh đạo',
    description: 'Hiện trạng: chỉ số đúng giờ theo khối phải tổng hợp thủ công từ nhiều báo cáo rời rạc.\nGiá trị đem lại: có bảng chỉ số tự động cập nhật theo ngày, giúp lãnh đạo nắm tình hình nhanh.\nThời gian triển khai: cần thêm thời gian nghiên cứu.\nSự tham gia CQ/ĐV: nội bộ Trung tâm điều hành khai thác tự thực hiện.\nChi phí: tự cân đối tại CQĐV.',
    areas: ['Khai thác bay'],
    cover: null, files: [],
    authors: [{ id: 'u7', percent: 100 }],
    participants: [],
    manager: 'u11', followers: [],
    onBehalf: false,
    status: 'completed', level: 2, target: null,
    qualified: true, closedAt: '14/04/2026',
    expertReviewPending: false, expertRequests: [],
    history: [
      { at: '20/02/2026 08:00', who: 'u7', action: 'lưu nháp hồ sơ' },
      { at: '20/02/2026 09:00', who: 'u7', action: 'gửi hồ sơ' },
      { at: '23/02/2026 10:00', who: 'u11', action: 'chấm điểm' },
      { at: '23/02/2026 10:05', who: 'u11', action: 'chuyển cấp' },
      { at: '02/03/2026 11:00', who: 'u22', action: 'chấm điểm, không chuyển cấp' },
      { at: '14/04/2026 14:00', who: 'u22', action: 'nhập số tiền đã chi, giải ngân' },
    ],
    scores: [
      { level: 1, roleLabel: 'CBQL trực tiếp', by: 'u11', total: 70, note: 'Hữu ích cho báo cáo lãnh đạo.', breakdown: { urgency: 20, benefit: 20, timeline: 5, participation: 10, cost: 15 } },
      { level: 2, roleLabel: 'Trưởng CQĐV', by: 'u22', total: 76, note: 'Chấm điểm chốt, phù hợp áp dụng tại Khối.', breakdown: { urgency: 20, benefit: 22, timeline: 9, participation: 10, cost: 15 } },
    ],
    reward: { amount: '600.000 đ', level: 'Giám đốc Khối/lĩnh vực', scoreTier: '70 - <90' },
  },

  'GP-2026-0038': {
    id: 'GP-2026-0038', type: 'solution', title: 'Chuẩn hóa quy trình xử lý yêu cầu khách hàng đa kênh',
    content: 'Xây dựng quy trình tiếp nhận và xử lý yêu cầu khách hàng thống nhất giữa các kênh (điện thoại, email, mạng xã hội), có SLA rõ ràng theo từng loại yêu cầu.',
    areas: ['Dịch vụ'],
    cost: '45000000', novelty: 'Hiện mỗi kênh xử lý yêu cầu khách hàng theo cách khác nhau, thiếu SLA thống nhất.', benefit: 'Giảm thời gian phản hồi khách hàng, tăng mức độ hài lòng.',
    trialDate: '2026-02-15', other: '',
    cover: null, files: [],
    authors: [{ id: 'u8', percent: 100 }],
    participants: [],
    manager: 'u16', followers: [],
    onBehalf: false,
    status: 'completed', level: 1, target: null,
    qualified: true, closedAt: '08/03/2026',
    expertReviewPending: false, expertRequests: [],
    history: [
      { at: '25/01/2026 08:00', who: 'u8', action: 'lưu nháp hồ sơ' },
      { at: '25/01/2026 09:00', who: 'u8', action: 'gửi hồ sơ' },
      { at: '28/01/2026 10:00', who: 'u16', action: 'chấm điểm, không chuyển cấp' },
      { at: '08/03/2026 14:00', who: 'u16', action: 'nhập số tiền đã chi, giải ngân' },
    ],
    scores: [
      { level: 1, roleLabel: 'CBQL trực tiếp', by: 'u16', total: 74, note: 'Giải pháp thiết thực, dễ áp dụng ngay.', breakdown: { scope: 7, benefit: 52, convenience: 15 } },
    ],
    reward: { amount: '3.000.000 đ', level: 'Trưởng CQ/ĐV', scoreTier: '70 - <90' },
  },
};

// Gộp vào RECORD_SAMPLES đã có (window.RECORD_SAMPLES phải tồn tại trước khi file này chạy)
Object.assign(window.RECORD_SAMPLES, window.RECORD_SAMPLES_LIBRARY);

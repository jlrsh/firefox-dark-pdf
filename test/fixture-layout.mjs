// Where things are drawn on page 1 of test/fixtures/mixed.pdf, in PDF user
// space ([x, y, width, height], origin bottom-left). Shared by the fixture
// generator and the end-to-end checks.
export const MIXED_LAYOUT = {
  pastelBox: [50, 560, 240, 80],
  navyBox: [320, 560, 240, 80],
  plot: [50, 320, 240, 200],
  photo: [320, 320, 240, 200],
  alphaImage: [50, 190, 100, 100],
  maskedRect: [170, 190, 120, 100],
  grayGradient: [320, 240, 240, 40],
  colorGradient: [320, 190, 240, 40],
  stencil: [50, 100, 60, 60],
  highlight: [150, 112, 140, 22],
};

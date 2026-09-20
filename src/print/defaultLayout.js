// Default paperstamp layout used to seed the plugin when it has none saved.
// Positions are in mm; SDK uses them to render text items on the A4 page.
export function defaultLayoutDef() {
  return {
    pageWmm: 210,
    pageHmm: 297,
    orientation: 'portrait',
    items: [
      { id: 1, type: 'text', x: 10, y: 10, w: 40, h: 2, text: 'Name', name: 'name', fontSize: 12, align: 'left', valign: 'top' },
      { id: 2, type: 'text', x: 10, y: 18, w: 20, h: 2, text: 'Mobile', name: 'mob', fontSize: 12, align: 'left', valign: 'top' },
      { id: 3, type: 'text', x: 10, y: 26, w: 10, h: 2, text: 'Age', name: 'age', fontSize: 12, align: 'left', valign: 'top' },
      { id: 6, type: 'text', x: 10, y: 30, w: 15, h: 2, text: 'Gender', name: 'gender', fontSize: 12, align: 'left', valign: 'top' },
      { id: 7, type: 'text', x: 10, y: 34, w: 15, h: 2, text: 'Weight', name: 'weight', fontSize: 12, align: 'left', valign: 'top' },
      { id: 4, type: 'text', x: 10, y: 42, w: 15, h: 2, text: 'Date', name: 'date', fontSize: 12, align: 'left', valign: 'top' },
      { id: 5, type: 'text', x: 10, y: 50, w: 10, h: 2, text: 'Token', name: 'token', fontSize: 12, align: 'left', valign: 'top' },
      { id: 8, type: 'text', x: 10, y: 58, w: 15, h: 2, text: 'Follow up', name: 'followup', fontSize: 12, align: 'left', valign: 'top' },
      { id: 9, type: 'text', x: 10, y: 62, w: 20, h: 2, text: 'Payment', name: 'payment', fontSize: 12, align: 'left', valign: 'top' },
      { id: 10, type: 'text', x: 10, y: 66, w: 10, h: 2, text: 'Fee', name: 'fee', fontSize: 12, align: 'left', valign: 'top' },
    ],
  };
}

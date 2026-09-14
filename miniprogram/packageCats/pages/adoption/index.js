/**
 * 送养信息。
 *
 * 目前是静态占位。真正的送养流程要考虑 UGC 内容安全
 * （微信要求 msgSecCheck / imgSecCheck），等需求确定再做。
 */
Page({
  data: {
    items: [
      {
        id: 'a1',
        title: '三只小奶猫找家',
        time: '2026 年 5 月',
        text: '在体育馆后面发现的三只小奶猫，已完成基础体检和驱虫。希望找有耐心的领养人，需签领养协议并接受回访。',
      },
      {
        id: 'a2',
        title: '春季绝育计划进展',
        time: '2026 年 4 月',
        text: '本学期已完成 6 只校园猫的绝育，感谢每一位帮忙的同学。',
      },
    ],
  },

  onContact() {
    wx.showModal({
      title: '联系我们',
      content: '有意领养或想加入喂养志愿者，请在公众号后台留言。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});

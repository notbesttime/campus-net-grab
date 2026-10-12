'use strict';
/* 占用确认弹窗的内容组装（纯函数，无副作用，便于单测）
 *
 * 为什么抽出来：这条链路反复出问题——先是「两处弹窗问同一件事」（§19.11），
 * 后是「拿不到设备列表时点了解绑是空点击，得回去再点一次一键抢网」（2026-10-12）。
 * 分支只有两种（有列表 / 没列表），但文案里必须**一次**说清后续所有动作
 * （注销后台占用 → 取列表 → 解绑 → 重登），靠真机试错代价太高，所以让它可单测。
 *
 * 纪律：本文件随公开仓库发布，示例与夹具只能写编造的 MAC（aa:bb:cc:dd:ee:xx 一族）。
 */

/**
 * 组装「登录被拒（名额被占）」那唯一一次确认弹窗的内容。
 * @param {Array} others 解绑候选：`{ text, ip, mac, type, maybeSelf }`；空数组 = 还没取到列表
 * @returns {{kind: string, hint: string, detail: string, devices: Array, needList: boolean, selfLogout: boolean}}
 *   `needList` = 此刻没有设备列表（同意后要先去取）；
 *   `selfLogout` = 这次确认里会**先注销自助后台的登录占用**（不影响上网账号）。
 */
function occupancyPrompt(others) {
  const list = Array.isArray(others) ? others.filter(Boolean) : [];
  const devices = list.map(d => ({
    text: d.text, ip: d.ip, mac: d.mac, type: d.type, maybeSelf: !!d.maybeSelf,
  }));
  const needList = list.length === 0;
  const nMaybe = devices.filter(d => d.maybeSelf).length;

  const hint = needList
    ? '登录被拒——PC 名额被占用，但自助后台取不到设备列表'
    : `登录被拒——PC 名额被 ${list.length} 条会话占用`
      + (nMaybe ? `（其中 ${nMaybe} 条可能是你的旧会话）` : '');

  // 有列表：直接说解绑哪几台 + 之后会自动重登。
  // 没列表：必须把「先注销后台占用、输一次验证码取回列表、自动解绑 PC（手机不动）」都写出来，
  //         否则用户点了「继续」并不知道会发生什么（这正是原来那次空点击的由来）。
  const detail = needList
    ? '自助后台取不到设备列表：它是单会话排他，本机残留的后台登录占用要先注销（注销它不影响上网账号）。'
      + '同意后：注销后台占用 → 输一次验证码取回设备列表 → 自动解绑本账号下占用的 PC 设备（手机不动）'
      + '→ 自动重新登录，全部在同一次点击里完成。'
    : (nMaybe
      ? '标「可能本机」的是你自己换过 MAC 的旧会话（Wi-Fi「随机硬件地址」所致）。'
      : '')
      + '同意后：解绑下列设备 → 等它真的下线 → 自动重新登录，全部在同一次点击里完成。';

  return { kind: 'unbind', hint, detail, devices, needList, selfLogout: needList };
}

module.exports = { occupancyPrompt };
# MultiCC 插件列表

[MultiCC](https://github.com/lsjwzh/MultiCC) 的插件面板读的就是这里的 `index.json`：列出所有插件（随 MultiCC 发布的内置插件，以及需要另外安装的插件），每个版本写清楚它对系统、MultiCC、Agent 和外部 App 的要求，MultiCC 再据此判断这台机器能装什么。

完整设计见 MultiCC 仓库的 [`docs/plugin-catalog-design.md`](https://github.com/lsjwzh/MultiCC/blob/main/docs/plugin-catalog-design.md)。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.json` | 插件列表本身 |
| `index.json.sig` | 对 `index.json` 原始字节的 ed25519 签名。MultiCC 只接受用它内置公钥验得过的列表 |
| `keys.json` | 签名公钥（和 MultiCC `src/plugins/catalog.js` 里的 `CATALOG_KEYS` 一致） |
| `scripts/validate.js` | 发布前和 CI 里的格式检查，比 MultiCC 更严：任何一处不对就整份拒绝 |
| `scripts/sign.js` | 更新 `updatedAt`、规范格式、检查、签名 |

MultiCC 从 `https://raw.githubusercontent.com/lsjwzh/multicc-plugins/main/index.json` 拉取，失败时改走 jsDelivr 镜像。镜像只能加快下载，改不了内容；比本机缓存更旧的列表也会被拒绝，所以每次发布 `updatedAt` 都必须往后走（`sign.js` 会处理）。

## 格式（schema 1）

```jsonc
{
  "schema": 1,
  "updatedAt": "2026-10-28T08:00:00Z",
  "plugins": [
    {
      "id": "wechat-desktop-notify",          // 和插件目录名、plugin.json 的 id 一致
      "name": "微信桌面提醒", "nameEn": "WeChat Desktop Notify",
      "icon": "💬",
      "category": "channel",                   // channel / browser
      "provides": ["channel"],                 // 推送设置、钩子按这个列出插件
      "distribution": "optional",              // builtin：随 MultiCC 发布；optional：另外安装
      "summary": "…", "summaryEn": "…",
      "homepage": "https://github.com/lsjwzh/multicc-wechat-notify",
      "latest": "0.1.0",                       // 必须是 releases 里最新的那个
      "releases": [
        {
          "version": "0.1.0",
          "publishedAt": "2026-11-05T00:00:00Z",
          "requires": {
            "multicc": ">=2.13.0",             // 支持 >=、<、^、=，空格分隔表示同时满足
            "pluginApi": 1,                    // 需要的插件接口版本
            "agentBuild": ">=2",               // 需要的 MultiCC Agent 构建号
            "platforms": [{ "os": "darwin", "arch": ["arm64", "x64"], "minOS": "13.0" }],
            "apps": [{ "id": "com.tencent.xinWeChat", "name": "微信", "nameEn": "WeChat",
                       "minVersion": "4.0.0", "testedVersion": "4.1.15",
                       "macosPaths": ["/Applications/WeChat.app"] }],
            "permissions": ["accessibility", "screenRecording"]
          },
          "assets": {
            "darwin-arm64": { "url": "https://github.com/…/releases/download/v0.1.0/….zip", "sha256": "…", "size": 1234567 }
          },
          "notes": "…", "notesEn": "…"
        }
      ]
    }
  ]
}
```

- 内置插件写 `builtinSince`（第一个带它的 MultiCC 版本），不写 `releases`。
- `requires` 里只能用上面这几项。MultiCC 遇到不认识的要求，会把这个版本显示成“需要更新版本的 MultiCC 才能判断能不能用”，所以新增一种要求之前，要先在 MultiCC 里实现它的判断。
- 下载包只能放在 GitHub Release 上，`sha256` 和 `size` 必须和文件一致（CI 会下载核对）。

## 发布一次

```bash
# 1. 改 index.json（加插件、加版本、改说明）
# 2. 签名：读本机钥匙串里的私钥，更新 updatedAt，写 index.json.sig
node scripts/sign.js
# 3. 本地再查一遍（含签名和下载包）
node scripts/validate.js --signature --assets
# 4. 提交并推送 index.json 和 index.json.sig
```

私钥只在维护者的 macOS 登录钥匙串里（条目 `multicc-plugin-catalog-signing`），不进这个仓库，CI 也拿不到；CI 只用 `keys.json` 验签。

## 换签名密钥

1. 生成新密钥，把公钥加进 MultiCC 的 `CATALOG_KEYS` 和这里的 `keys.json`，旧公钥先保留；
2. 等带新公钥的 MultiCC 发布、大多数用户升级后，`sign.js` 改用新的 `KEY_ID`；
3. 再过一段时间，从两边删掉旧公钥。

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
| `scripts/release.js` | 把一个插件按平台打成下载包、传到 GitHub Release、写进 `index.json` |

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

## 发布一个可另外安装的插件（新版本也一样）

插件目录里要有 `plugin.json`（`id`、`version`、`name`/`nameEn`、`description`/`descriptionEn` 或 `summary`/`summaryEn`、`requires`，`engine.binaryPlatformDir` 指向按平台放的可执行文件），以及每个要支持的平台编好的 `bin/<os>-<arch>/<可执行文件>`。

```bash
# 1. 先只打包：每个平台一个 zip 放进 dist/，打印将要写进 index.json 的条目，什么都不上传
node scripts/release.js ../<插件目录> --notes "这一版改了什么" --notes-en "What changed"
# 2. 确认无误后发布：建 Release（tag 是 <id>-v<version>）、上传 zip、把这个版本写进 index.json
HTTPS_PROXY=http://127.0.0.1:7897 node scripts/release.js ../<插件目录> --notes "…" --notes-en "…" --publish
# 3. 照常签名、核对、提交推送（见下一节第 2–4 步）
```

- 下载包只装运行需要的东西：`plugin.json`、界面目录、本平台的 `bin/<os>-<arch>/`、`README.md`/`LICENSE`/`THIRD_PARTY.md`/`CHANGELOG.md`，以及 `plugin.json` 的 `files` 里列出的文件。源码不进包，链接一律拒收，可执行文件保留执行权限。
- 默认放在本仓库的 Release 里，插件源码可以不公开；`--repo owner/name` 可改放插件自己的仓库。
- `requires.multicc` 要写成带一键安装的 MultiCC 版本或更高：更早的版本没有安装按钮。
- 同一个版本只能发布一次，要改就升版本号。MultiCC 只装大小和 sha256 都和这里一致的包，解压后 `plugin.json` 的 id、版本也必须和这里一致。

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

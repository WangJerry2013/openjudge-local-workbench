# OpenJudge 刷题台（桌面版）

一个非官方的 OpenJudge 本地桌面客户端，支持 macOS 和 Windows。

## 下载与安装

- macOS（Apple 芯片）：打开 `OpenJudge刷题台-macOS-AppleSilicon.dmg`，把应用拖入“应用程序”。
- Windows 64 位：运行 `OpenJudge刷题台-Windows-x64-安装程序.exe`。
- 不想安装时，可运行 Windows 便携版，或解压 Windows ZIP 后打开 `OpenJudge刷题台.exe`。

当前 macOS 包未使用付费开发者证书签名。首次打开若被系统拦截，请在“系统设置 → 隐私与安全性”中选择允许打开。Windows 首次运行也可能显示未知发布者提示。

## 功能

- 自动读取题目列表和题面
- 可把任意 `*.openjudge.cn` 团队保存到左侧本地目录，支持刷新全部、移除本地团队入口，并按“比赛 / 题单 / 题目”分层展开或一键全部收回
- 浏览器本地题目缓存，可离线查看已缓存题目
- 在应用内登录 OpenJudge（包括官网图片验证码）
- 直接提交代码、轮询评测结果、查看分数、状态、历史记录和源代码
- DeepSeek 题目翻译（API Key 只保存在应用进程内存中）
- 上一步 / 下一步浏览历史
- 右上角通知中心，连续消息以列表堆叠并自动消失
- 原站出现 502 时重试并回退到磁盘缓存

## 隐私与安全

- 账号、密码和 DeepSeek API Key 不写入文件。
- 登录会话只保存在应用进程内存中，退出应用后清除。
- 添加团队只保存团队地址到本机，不会申请加入团队或改变 OpenJudge 成员资格。
- 应用仅通过 OpenJudge 和用户主动配置的 DeepSeek 官方接口联网。
- 本项目不会绕过 OpenJudge 权限、验证码或访问控制。

## 本地开发

需要 Node.js 22：

```bash
npm install
npm start
```

## 打包

```bash
npm run pack:mac
npm run pack:win
```

生成正式安装包：

```bash
npm run dist:mac
npm run dist:win
```

仓库自带 GitHub Actions；推送 `v*` 标签后会分别在 macOS 与 Windows 官方环境中构建发布文件。

## 免责声明

本项目不是 OpenJudge 官方产品。使用时请遵守 OpenJudge 的服务规则，并合理控制请求频率。

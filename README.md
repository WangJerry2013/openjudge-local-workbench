# OpenJudge 刷题台（浏览器版）

一个仅在本机浏览器运行的 OpenJudge 刷题台。无需安装桌面应用。

## 一键启动

- **macOS**：双击 `启动刷题台.command`。
- **Windows**：双击 `启动刷题台.bat`。

首次运行需要安装 Python 3。启动后会自动打开 <http://localhost:8000>；保持命令窗口打开即可继续使用。

## 功能

- 加载团队、比赛、题单和题目，并在本机缓存已读取内容
- 在浏览器中登录 OpenJudge，支持官网要求的图片验证码
- 直接提交代码、查看评测状态、分数、提交记录和源代码
- 浏览器本地保存代码、题目缓存、目录缓存与题目分数
- 可选 DeepSeek 题面翻译，翻译缓存 10 天

## 手动启动

```bash
python3 server.py --open
```

Windows 也可使用：

```bat
py -3 server.py --open
```

## 隐私与安全

- 账号密码和 DeepSeek API Key 不写入文件。
- 登录会话只保存在服务运行期间的内存中；停止服务后即清除。
- 本项目不会绕过 OpenJudge 权限、验证码或访问控制。

本项目不是 OpenJudge 官方产品。请遵守 OpenJudge 的服务规则并合理控制请求频率。

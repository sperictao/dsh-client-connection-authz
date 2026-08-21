# dsh-client-connection-authz

DeepSeek Harness `0.1.0-rc.x` 内置 connection 的完整替代包。它保留官方
HTTP、共享/独立 RPC、WebSocket 和浏览器 client 行为，并在所有远程入口前
增加一个由外部插件提供的 `ConnectionRequestAuthorizer`。

## 设计

本包的 bundle patch 做两件事：

1. 用 `id + name` 双重匹配禁用内置
   `@deepseek-ai/dsh-client-connection`；如果上游改名，patch 会显式告警而不会
   误伤复用该 id 的其它插件。
2. 插入 `@dsh-external/dsh-client-connection-authz`，并强制注入
   `connectionRequestAuthorizer`。认证插件缺失或配置失败时，connection 不会以
   匿名模式降级启动。

浏览器 bundle 来自官方 `@deepseek-ai/dsh-client-connection`（跟随 package.json
声明的依赖范围），构建时只替换模块表 id；脚本校验唯一 id 出现次数防止静默漂移，
不校验上游精确版本。Host 源码基于
DeepSeek Harness commit `47f943859bef60e4160492346772ded9b24f765a`，来源见
[NOTICE.md](NOTICE.md)。

## 授权接口

```ts
interface ConnectionRequestAuthorizer {
  authorize(facts: ConnectionRequestFacts):
    | { allowed: true; principal: ConnectionPrincipal }
    | { allowed: false; status: 401 | 403 }
}
```

`facts` 包含 transport、channel、endpoint、headers、TCP peer address，以及目标
要求的 authority：

- `trusted-host`：普通 API、普通 RPC 和两个 WebSocket downlink。
- `loopback`：设置、凭据、宿主文件操作等特权 API；认证插件只有显式授予更高权限
  才能让远程调用通过。

执行顺序固定为：Host/Origin/DNS-rebinding fence → 本地回环判断 → 外部
authorizer → body 读取/协议升级/业务 handler。有效本地旁路必须同时满足回环 Host
和回环 TCP peer；远端仅伪造 `Host: 127.0.0.1` 仍会进入 authorizer。共享 RPC 会在
授权前把 handler 与 authority 快照为同一 target，避免授权后切换 interceptor 的
时序绕过。

## 安装

这个包故意不能单独启用；profile 还必须安装一个提供 authorizer 的认证包。例如与
[dsh-auth-tailscale](https://github.com/sperictao/dsh-auth-tailscale) 一起安装：

```bash
gh auth setup-git
dsh plugin --profile web add \
  git+https://github.com/sperictao/dsh-client-connection-authz.git \
  git+https://github.com/sperictao/dsh-auth-tailscale.git
```

两个仓库目前是 private；上面的已验证路径使用当前 `gh` 登录为 Git 配置 HTTPS
凭据。也可以改用已配置公钥的 SSH URL。

## 开发

```bash
pnpm install
pnpm check
```

测试覆盖 HTTP、共享/独立 RPC、WebSocket、特权 authority、回环 Host 伪造和既有
trust fence。`pnpm build` 生成并校验官方浏览器 bundle。

## 兼容范围

依赖声明（package.json 的 `^0.1.0-rc.8` 等）是本包与 dsh 版本兼容性的唯一事实
来源：范围语义承诺该包在任何满足范围的 dsh 版本下工作。升级 dsh 到新 rc 时，
本包的依赖范围随 `^` 自动覆盖（npm 预发布语义下 `^0.1.0-rc.8` 匹配
`0.1.1-rc.1` 等后续 rc）；只有当上游 d.ts 出现 breaking change 时才需要改代码，
此时 bump 本包版本并把依赖范围同步到新下限。不能用锁死确切版本的方式"防漂移"——
那只会让 pnpm 在 profile 里解出版本裂缝（rc.6 插件 + rc.8 核心的 boot 崩溃
就是这么来的）。

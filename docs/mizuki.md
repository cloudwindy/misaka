# Mizuki 路由器

Mizuki 路由器是一个适用于 Misaka 服务器的路由器，基于域名（site）和路径（path）进行路由，并将请求交给指定的处理器（handler）进行处理。

## 配置文件

Mizuki 路由器与 Misaka 服务器的配置都应在 config.yaml 文件中指定。

```yaml
router:
  <RouterConfig>
  https: true | false
  verbose: true | false
  routes:
    [site: string]: <SiteConfig>
    www.example.com:
      [path: string]: <PathConfig>
      ^/:
        [handler]: <HandlerConfig>
```

- https：是否启用强制 HTTPS（301 重定向到 HTTPS）。
- verbose：是否打印路由表。
- routes：路由表。

## 路由表

路由表中包含域名、路径和处理器的信息。

### 域名

指定目标域名。可以是一个字符串、数组、以“/”包裹的正则表达式，或是"\*"表示任意域名。域名的顺序决定了它的处理顺序，所以请将模糊的条件置于精确的条件下方（例如"\*"总是应该置于最底端）。

### 路径

指定目标路径。可以是一个字符串、[https://github.com/pillarjs/path-to-regexp](path-to-regexp) 指定的

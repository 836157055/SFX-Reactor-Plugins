# SFX-Reactor-Plugins

SFX Reactor 官方插件市场仓库 —— 应用内「插件市场」板块（设置页 → 插件管理）的数据源。

## 结构

```
index.json          ← 市场索引（应用只拉这个文件）
plugins/<id>/       ← 每个插件一个子目录，id 与插件 manifest.id 一致
  script.js         ← 插件入口（必须）
  .sfx-plugin.json  ← 清单（可选）
```

## index.json 字段

| 字段 | 说明 |
|---|---|
| `version` | 索引格式版本，当前为 1 |
| `id` | 插件唯一标识，必须与 manifest.id 一致 |
| `name` / `description` / `author` / `tags` | 展示用，与 manifest 保持一致 |
| `version`（插件条目内） | 语义化版本，应用据此检测更新 |
| `permissions` | 声明权限集，安装前展示 |
| `path` | 仓库内目录前缀，以 `/` 结尾 |
| `files` | 需要下载的文件列表 |
| `minAppVersion`（可选） | 低于此应用版本时条目置灰 |

## 上架流程（官方独占）

1. `plugins/<id>/` 放入插件文件；
2. index.json 追加条目（核对 id == manifest.id）；
3. 推送到 main，应用侧「刷新市场」即可见。

# 用户登录流程时序图

## 基础登录流程

```mermaid
sequenceDiagram
    actor User as 用户
    participant Browser as 浏览器/客户端
    participant Frontend as 前端应用
    participant Backend as 后端服务
    participant Auth as 认证服务
    participant DB as 数据库
    participant Cache as 缓存(Redis)

    User->>Browser: 1. 打开登录页面
    Browser->>Frontend: 2. 请求登录页面
    Frontend-->>Browser: 3. 返回登录表单
    
    User->>Browser: 4. 输入用户名和密码
    User->>Browser: 5. 点击登录按钮
    
    Browser->>Frontend: 6. 提交登录表单
    Frontend->>Frontend: 7. 前端表单验证
    
    alt 表单验证失败
        Frontend-->>Browser: 8a. 返回错误提示
        Browser-->>User: 显示错误信息
    else 表单验证通过
        Frontend->>Backend: 8b. POST /api/login {username, password}
        
        Backend->>Backend: 9. 参数校验
        Backend->>Auth: 10. 请求认证
        
        Auth->>DB: 11. 查询用户信息
        DB-->>Auth: 12. 返回用户数据
        
        alt 用户不存在
            Auth-->>Backend: 13a. 用户不存在
            Backend-->>Frontend: 14a. 返回错误 (用户名或密码错误)
            Frontend-->>Browser: 15a. 显示错误提示
            Browser-->>User: 用户名或密码错误
        else 用户存在
            Auth->>Auth: 13b. 验证密码哈希
            
            alt 密码错误
                Auth->>DB: 14b1. 记录登录失败次数
                Auth-->>Backend: 14b2. 密码错误
                Backend-->>Frontend: 15b. 返回错误
                Frontend-->>Browser: 16b. 显示错误提示
                Browser-->>User: 用户名或密码错误
            else 密码正确
                Auth->>Auth: 14c. 生成 JWT Token
                Auth->>Cache: 15c. 存储 Session/Token
                Cache-->>Auth: 16c. 存储成功
                
                Auth->>DB: 17c. 更新最后登录时间
                Auth-->>Backend: 18c. 返回 Token 和用户信息
                
                Backend-->>Frontend: 19c. 返回成功响应 {token, userInfo}
                Frontend->>Frontend: 20c. 存储 Token (localStorage/Cookie)
                Frontend-->>Browser: 21c. 跳转到主页
                Browser-->>User: 22c. 显示登录成功，进入系统
            end
        end
    end
```

## 带验证码的登录流程

```mermaid
sequenceDiagram
    actor User as 用户
    participant Browser as 浏览器
    participant Frontend as 前端应用
    participant Backend as 后端服务
    participant Captcha as 验证码服务
    participant Auth as 认证服务
    participant DB as 数据库

    User->>Browser: 1. 打开登录页面
    Browser->>Frontend: 2. 请求登录页面
    Frontend->>Backend: 3. 请求验证码
    Backend->>Captcha: 4. 生成验证码
    Captcha-->>Backend: 5. 返回验证码图片和ID
    Backend-->>Frontend: 6. 返回验证码
    Frontend-->>Browser: 7. 显示登录表单和验证码
    
    User->>Browser: 8. 输入用户名、密码和验证码
    User->>Browser: 9. 点击登录
    
    Browser->>Frontend: 10. 提交表单
    Frontend->>Backend: 11. POST /api/login {username, password, captcha, captchaId}
    
    Backend->>Captcha: 12. 验证验证码
    
    alt 验证码错误
        Captcha-->>Backend: 13a. 验证失败
        Backend-->>Frontend: 14a. 返回错误
        Frontend-->>User: 验证码错误，请重新输入
    else 验证码正确
        Backend->>Auth: 13b. 进行用户认证
        Auth->>DB: 14b. 查询并验证用户
        DB-->>Auth: 15b. 返回结果
        Auth-->>Backend: 16b. 返回 Token
        Backend-->>Frontend: 17b. 登录成功
        Frontend-->>User: 跳转到主页
    end
```

## 多因素认证(MFA)登录流程

```mermaid
sequenceDiagram
    actor User as 用户
    participant App as 应用
    participant Backend as 后端服务
    participant Auth as 认证服务
    participant MFA as MFA服务
    participant SMS as 短信服务
    participant DB as 数据库

    User->>App: 1. 输入用户名和密码
    App->>Backend: 2. POST /api/login/step1
    Backend->>Auth: 3. 验证用户名密码
    Auth->>DB: 4. 查询用户信息
    DB-->>Auth: 5. 返回用户数据(含MFA设置)
    
    alt 密码错误
        Auth-->>Backend: 6a. 认证失败
        Backend-->>App: 7a. 返回错误
        App-->>User: 用户名或密码错误
    else 密码正确且启用MFA
        Auth-->>Backend: 6b. 第一步认证成功，需要MFA
        Backend->>MFA: 7b. 请求发送验证码
        MFA->>SMS: 8b. 发送短信验证码
        SMS-->>MFA: 9b. 发送成功
        MFA-->>Backend: 10b. 验证码已发送
        Backend-->>App: 11b. 返回临时Token，要求MFA验证
        
        App-->>User: 12b. 显示MFA验证页面
        User->>App: 13b. 输入验证码
        App->>Backend: 14b. POST /api/login/step2 {tempToken, mfaCode}
        Backend->>MFA: 15b. 验证MFA代码
        
        alt MFA验证失败
            MFA-->>Backend: 16b1. 验证失败
            Backend-->>App: 17b1. 返回错误
            App-->>User: 验证码错误
        else MFA验证成功
            MFA-->>Backend: 16b2. 验证成功
            Backend->>Auth: 17b2. 生成最终Token
            Auth-->>Backend: 18b2. 返回Token
            Backend-->>App: 19b2. 登录成功
            App-->>User: 进入系统
        end
    end
```

## 使用说明

### 文件格式
- 本文件使用 Mermaid 语法编写时序图
- 可在支持 Mermaid 的工具中查看，例如：
  - GitHub/GitLab（直接预览）
  - VS Code（安装 Mermaid 插件）
  - 在线工具：https://mermaid.live/

### 流程说明

**基础登录流程**包含：
- 前端表单验证
- 用户认证
- 密码哈希验证
- Token 生成与存储
- 登录失败处理

**带验证码流程**增加：
- 验证码生成与验证
- 防止暴力破解

**多因素认证流程**增加：
- 两步验证
- 短信验证码
- 临时 Token 机制

### 关键安全点

1. **密码处理**：使用哈希存储，不返回明文
2. **错误提示**：用户不存在和密码错误返回相同提示
3. **失败次数**：记录登录失败次数，防止暴力破解
4. **Token 管理**：使用 JWT 或 Session，设置过期时间
5. **验证码**：防止自动化攻击
6. **MFA**：高安全场景的必要措施

/**
 * Moltbook Integration Skill
 * Post and comment on Moltbook platform
 */

import { HttpsProxyAgent } from 'https-proxy-agent';

const MOLTBOOK_API_BASE = process.env.MOLTBOOK_API_BASE || 'https://www.moltbook.com';
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || '';

/**
 * Get authentication headers
 */
function getAuthHeaders() {
  const bearer = process.env.MOLTBOOK_BEARER_TOKEN || '';
  if (bearer) {
    return { 'Authorization': `Bearer ${bearer}` };
  }
  if (MOLTBOOK_API_KEY) {
    const header = process.env.MOLTBOOK_AUTH_HEADER || 'x-api-key';
    return { [header]: MOLTBOOK_API_KEY };
  }
  return {};
}

/**
 * Get proxy agent if needed
 */
function getProxyAgent() {
  const proxyUrl = process.env.OPENAI_PROXY_URL || process.env.GEMINI_PROXY_URL || 'http://127.0.0.1:7890';
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Make API request to Moltbook
 */
async function moltbookRequest(endpoint, options = {}) {
  const url = `${MOLTBOOK_API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
    ...options.headers
  };

  const agent = getProxyAgent();
  const fetchOptions = {
    ...options,
    headers
  };

  // Add proxy agent if available
  if (agent) {
    fetchOptions.agent = agent;
  }

  const response = await fetch(url, fetchOptions);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Moltbook API error: ${response.status} - ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Create a new post
 */
async function createPost(payload) {
  const { title, content, submolt } = payload;

  const postData = {
    title: title || 'JPClaw Update',
    content,
    submolt: submolt || 'general' // Default submolt
  };

  const result = await moltbookRequest('/api/v1/posts', {
    method: 'POST',
    body: JSON.stringify(postData)
  });

  return {
    ok: true,
    action: 'post',
    post_id: result.id || result.post?.id,
    url: result.url || `${MOLTBOOK_API_BASE}/p/${result.id || result.post?.id}`,
    message: `✅ 帖子已发布！\n标题: ${title}\n链接: ${result.url || `${MOLTBOOK_API_BASE}/p/${result.id}`}`
  };
}

/**
 * Add a comment to a post
 */
async function createComment(payload) {
  const { post_id, content, parent_id, agent_name } = payload;

  if (!post_id) {
    throw new Error('post_id is required for comments');
  }

  const commentData = {
    content,
    ...(parent_id && { parent_id }),
    ...(agent_name && { agent_name })
  };

  const result = await moltbookRequest(`/api/v1/posts/${post_id}/comments`, {
    method: 'POST',
    body: JSON.stringify(commentData)
  });

  return {
    ok: true,
    action: 'comment',
    comment_id: result.id || result.comment?.id,
    post_id,
    url: `${MOLTBOOK_API_BASE}/p/${post_id}#${result.id}`,
    message: `✅ 评论已发布！\n帖子: ${post_id}\n链接: ${MOLTBOOK_API_BASE}/p/${post_id}`
  };
}

/**
 * Query posts
 */
async function queryPosts(payload) {
  const { type = 'recent', post_id, limit = 20 } = payload;

  if (type === 'single' && post_id) {
    const result = await moltbookRequest(`/api/v1/posts/${post_id}`);
    return {
      ok: true,
      action: 'query',
      type: 'single',
      post: result
    };
  }

  // Get recent posts
  const result = await moltbookRequest(`/api/v1/agent/posts?limit=${limit}`);
  return {
    ok: true,
    action: 'query',
    type: 'recent',
    posts: result.posts || result,
    count: (result.posts || result).length
  };
}

/**
 * Get current agent status
 */
async function getAgentStatus() {
  const result = await moltbookRequest('/api/v1/agents/status');
  return {
    ok: true,
    action: 'status',
    agent: result.agent
  };
}

/**
 * Generate content using AI based on seed prompt
 */
async function generateContent(seed) {
  // Simple content generation based on seed
  const templates = [
    `${seed}\n\n分享一些最近的思考和实践经验。`,
    `关于 ${seed}，有一些新的想法想和大家分享。`,
    `${seed}\n\n持续探索和优化中，欢迎交流讨论！`
  ];

  const template = templates[Math.floor(Math.random() * templates.length)];
  return template;
}

/**
 * Replace placeholders in string
 */
function replacePlaceholders(str) {
  if (!str) return str;

  const now = new Date();
  const time = now.toISOString().replace('T', ' ').substring(0, 19);

  return str
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{date\}\}/g, now.toISOString().split('T')[0]);
}

/**
 * Auto post with content generation
 */
async function autoPost(payload) {
  const { title, seed, submolt } = payload;

  // Generate content if seed is provided
  const content = seed ? await generateContent(seed) : payload.content;

  // Replace placeholders in title
  const finalTitle = replacePlaceholders(title || 'JPClaw Update {{time}}');

  return await createPost({
    title: finalTitle,
    content: content || '自动更新',
    submolt
  });
}

/**
 * Comment on latest self post
 */
async function commentLatestSelf(payload) {
  // Get my latest post
  const queryResult = await queryPosts({ type: 'recent', limit: 1 });

  if (!queryResult.posts || queryResult.posts.length === 0) {
    throw new Error('No posts found');
  }

  const latestPost = queryResult.posts[0];
  const postId = latestPost.id || latestPost.post_id;

  // Generate comment content
  const content = payload.content || `持续迭代中... 🚀\n\n更新时间: ${new Date().toISOString().split('T')[0]}`;

  return await createComment({
    post_id: postId,
    content: replacePlaceholders(content)
  });
}

/**
 * Comment on latest other post
 */
async function commentLatestOther(payload) {
  // Get recent posts from feed (would need a different API endpoint)
  // For now, we'll throw a not implemented error
  throw new Error('comment_latest_other not yet implemented - requires feed API endpoint');
}

/**
 * Main entry point
 */
export async function run(input) {
  try {
    // Check for API key
    if (!MOLTBOOK_API_KEY && !process.env.MOLTBOOK_BEARER_TOKEN) {
      return JSON.stringify({
        ok: false,
        error: 'MOLTBOOK_API_KEY or MOLTBOOK_BEARER_TOKEN not configured',
        message: '请先配置 MOLTBOOK_API_KEY 环境变量'
      }, null, 2);
    }

    // Parse input
    let payload;
    try {
      payload = typeof input === 'string' ? JSON.parse(input) : input;
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: 'Invalid JSON input',
        message: '输入格式错误，请提供有效的JSON'
      }, null, 2);
    }

    const { action } = payload;

    // Route to appropriate handler
    let result;
    switch (action) {
      case 'post':
        result = payload.seed ? await autoPost(payload) : await createPost(payload);
        break;
      case 'comment':
        result = await createComment(payload);
        break;
      case 'comment_latest_self':
        result = await commentLatestSelf(payload);
        break;
      case 'comment_latest_other':
        result = await commentLatestOther(payload);
        break;
      case 'query':
        result = await queryPosts(payload);
        break;
      case 'status':
        result = await getAgentStatus();
        break;
      default:
        throw new Error(`Unknown action: ${action}. Supported: post, comment, comment_latest_self, comment_latest_other, query, status`);
    }

    return JSON.stringify(result, null, 2);

  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error.message,
      stack: error.stack
    }, null, 2);
  }
}

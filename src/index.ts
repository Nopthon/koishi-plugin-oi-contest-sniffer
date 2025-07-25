import { Context, Schema } from 'koishi'
import * as cheerio from 'cheerio';

export const name = 'coding-contests'

export interface Config {
  maxContests: number,
  startSearchFrom: number,
  greetings: string[],
  platformAliases: Record<string, string>,
  statusText: {
    upcoming: string,
    coding: string,
    ended: string
  }
}

export const Config: Schema<Config> = Schema.object({
  maxContests: Schema.number()
    .min(1).max(15)
    .default(5)
    .description('默认返回比赛数量'),

  startSearchFrom: Schema.number()
    .min(-7).max(15)
    .default(2)
    .description('筛选从（  ）天前存在的比赛，可以取负数表示搜索从（  ）天后开始的比赛。这个值会影响到 -s ended 的查找范围'),

  greetings: Schema.array(String)
    .default([
      '还在打OI哦，休息一下吧 ♪(´▽｀)',
      '今日宜：AK',
      'ο(=•ω＜=)ρ⌒☆',
      '想打比赛吗？那就来吧！(o゜▽゜)o☆',
      '今天你开long long了吗 ( •̀ ω •́ )',
      '唉你们OIer好可怕 O_O',
    ])
    .description('自定义问候语列表，每次随机选择一条显示在结果顶部'),

  platformAliases: Schema.dict(String)
    .default({
      'codeforces': 'Codeforces',
      'cf': 'Codeforces',
      'atcoder': 'AtCoder',
      'at': 'AtCoder',
      'ac': 'AtCoder',
      'lg': 'Luogu',
      '洛谷': 'Luogu',
      'luogu': 'Luogu'
    })
    .description('平台别名设置，键是别名，值是对应的平台名称（区分大小写）')
    .role('table'),

  statusText: Schema.object({
    upcoming: Schema.string()
      .default('还没开始 (●\' - \'●)')
      .description('未开始比赛的显示文本'),
    coding: Schema.string()
      .default('正在火热进行 OwO')
      .description('进行中比赛的显示文本'),
    ended: Schema.string()
      .default('结束嘞 o_o ....')
      .description('已结束比赛的显示文本')
  })
  .description('比赛状态显示文本配置')
})

// Contest 接口，统一各个平台比赛的相关数据
interface Contest {
  name: string;           // 比赛名称
  startTime: number;      // 开始时间（Unix时间戳，单位是秒）
  duration: number;       // 持续时间（单位是秒）
  phase: string;          // 比赛阶段（未开始/正在进行/已结束）
  url: string;            // 比赛链接
  platform?: string;      // 比赛平台（Optional）
}

// 主函数部分
export function apply(ctx: Context, config: Config) {
  ctx.command('oi', '获取最近的 OI 线上赛事的日程')
    .option('platform', '-p <platform> 筛选比赛平台 (比如: "cf", "atcoder", "luogu" 等参数，目前也仅支持查找这些比赛)')
    .option('phase', '-s <phase> 筛选比赛阶段 (支持 "upcoming", "coding", "ended" 三种参数)')
    .option('count', '-n <count> 限制一次性输出的比赛总数')
    .action(async ({ session, options }) => {
      try {

        // 获取所有比赛数据
        const contests = await fetchContests(ctx, config);

        // 预处理比赛数据（由 option 参数决定处理方式）
        const processed = processContests(contests, options, config);

        if (processed.length === 0) {
          return '嗯？这里没有找到符合条件的比赛 O_O';
        }

        // 格式化输出结果
        return generateOutput(processed, config);
      }
      catch (error) {
        console.error('Error occurs when fetching contests :(', error);
        return `出错了(T_T) 请稍后再试 (ง •_•)ง`;
      }
    });
}

// Func: 获取所有平台的比赛数据
// get_____Contests 子函数获得的比赛信息在这里进行处理与标签
async function fetchContests(ctx: Context, config: Config): Promise<Contest[]> {
  // 获取各平台比赛信息
  const [cfContests, atcoderContests, luoguContests] = await Promise.all([
    getCodeforcesContests(ctx),
    getAtcoderContests(ctx),
    getLuoguContests(ctx)
  ]);

  // 合并同类项，标记比赛来源方便后期筛选
  const allContests = [
    ...cfContests.map(c => ({ ...c, platform: 'Codeforces' })),
    ...atcoderContests.map(c => ({ ...c, platform: 'AtCoder' })),
    ...luoguContests.map(c => ({ ...c, platform: 'Luogu' }))
  ];

  // 筛选从 x 天前存在的比赛（太久远的比赛不显示）
  const dayStart = Math.floor(Date.now() / 1000) - config.startSearchFrom * 86400;

  return allContests.filter(contest => contest.startTime + contest.duration >= dayStart);
}


// Func: 根据 option 筛选并排序获得的比赛数据
function processContests(contests: Contest[], options: any, config: Config): Contest[] {
  let processed = [...contests];

  // 平台筛选（-p 参数）
  if (options.platform) {
    processed = processed.filter(c => c.platform === options.platform);
  }

  // 比赛阶段筛选（-s 参数）
  if (options.phase) {
    processed = processed.filter(c =>
      c.phase.toLowerCase().includes(options.phase.toLowerCase())
    );
  }

  // 按时间和状态排序
  processed.sort((a, b) => {
    // 按开始时间排序
    if (a.startTime && b.startTime) return a.startTime - b.startTime;
    // 进行中的比赛靠前
    if (a.phase.includes('coding')) return -1;
    if (b.phase.includes('coding')) return 1;
    // 已结束的比赛靠后
    if (a.phase.includes('ended')) return 1;
    if (b.phase.includes('ended')) return -1;
    return 0;
  });

  // 数量筛选（-n 参数）
  return processed.slice(0, options.count || config.maxContests);
}

// 构造比赛信息
function generateOutput(contests: Contest[], config: Config): string {
  // 使用配置中的状态文本，如果未配置则使用默认值
  const statusTexts = config.statusText || {
    upcoming: '还没开始 (●\' - \'●)',
    coding: '正在火热进行 OwO',
    ended: '结束嘞 o_o ....'
  };

  let output = config.greetings[Math.floor(Math.random() * config.greetings.length)] + '\n-------------\n';

  contests.forEach(contest => {
    output += `比赛平台: ${contest.platform}\n`;
    output += `比赛名: ${contest.name}\n`;

    if (contest.startTime) {
      const startTime = new Date(contest.startTime * 1000).toLocaleString('zh-CN');
      output += `开始时间: ${startTime}\n`;
    }

    if (contest.duration) {
      const duration = contest.duration / 60;
      output += `比赛时长: ${duration.toFixed(0)}min\n`;
    }

    // 根据比赛阶段获取状态文本（使用新的状态键名）
    let status = '';
    if (contest.phase.includes('upcoming')) {
      status = statusTexts.upcoming;
    } else if (contest.phase.includes('ongoing')) {
      status = statusTexts.coding;
    } else if (contest.phase.includes('ended')) {
      status = statusTexts.ended;
    }

    output += `比赛状态: ${status}\n`;

    if (contest.url) {
      output += `直达赛场: ${contest.url}\n`;
    }

    output += '------------\n';
  });

  return output;
}

// SubFunc:: 获取 Codeforces 比赛，通过 API 获取
async function getCodeforcesContests(ctx: Context): Promise<Contest[]> {
  try {
    // 请求Codeforces API获取比赛列表
    const response = await ctx.http.get('https://codeforces.com/api/contest.list', {
      params: { gym: false },
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });

    if (!response || response.status !== 'OK' || !Array.isArray(response.result)) {
      console.error('Codeforces API Structure mismatched:', response?.status || 'No response');
      return [];
    }

    const now = Math.floor(Date.now() / 1000);

    // 转换比赛数据为标准格式
    return response.result.map(contest => {
      const startTime = contest.startTimeSeconds;
      const endTime = startTime + contest.durationSeconds;

      let phase = 'upcoming';
      if (now > endTime) phase = 'ended';
      else if (now > startTime) phase = 'coding';

      return {
        name: contest.name,
        startTime,
        duration: contest.durationSeconds,
        phase,
        url: `https://codeforces.com/contests/${contest.id}`
      };
    });
  } catch (error) {
    console.error('Error occurs when fetching Codeforces contests :(', error);
    return [];
  }
}

// SubFunc:: 获取 Atcoder 比赛，利用 cheerio 爬取网站（无官方 API）
// ai 写的，我不会爬虫
async function getAtcoderContests(ctx: Context): Promise<Contest[]> {
  try {
    // 获取AtCoder比赛页面HTML
    const html = await ctx.http.get('https://atcoder.jp/contests', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const $ = cheerio.load(html);
    const contests: Contest[] = [];
    const now = Math.floor(Date.now() / 1000);

    const parseDuration = (text: string): number => {
      const [hours, minutes] = text.split(':').map(Number);
      return (hours * 3600) + (minutes * 60);
    };

    // 处理比赛表格
    $('.table-default tbody tr').each((i, el) => {
      const row = $(el);
      const startTimeText = row.find('td:nth-child(1)').text().trim();
      const contestLink = row.find('td:nth-child(2) a').attr('href');
      const contestName = row.find('td:nth-child(2) a').text().trim();
      const durationText = row.find('td:nth-child(3)').text().trim();

      if (!startTimeText || !contestLink) return;

      const startTime = new Date(startTimeText).getTime() / 1000;
      const duration = parseDuration(durationText);
      const endTime = startTime + duration;

      // 统一判断比赛阶段
      let phase: string;
      if (now < startTime) {
        phase = 'upcoming';
      } else if (now < endTime) {
        phase = 'coding';
      } else {
        phase = 'ended';
      }

      contests.push({
        name: contestName,
        startTime,
        duration,
        phase,
        url: `https://atcoder.jp${contestLink}`
      });
    });

    return contests;
  } catch (error) {
    console.error('Error occurs when fetching AtCoder contests :(', error);
    return [];
  }
}

// SubFunc: 获取 Luogu 比赛，利用 API 获取
async function getLuoguContests(ctx: Context): Promise<Contest[]> {
  try {
    const response = await ctx.http.get('https://www.luogu.com.cn/contest/list?_contentOnly=1', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.luogu.com.cn/contest/list'
      }
    });

    if (!response?.currentData?.contests?.result) {
      console.error('Luogu API Structure mismatched', response);
      return [];
    }

    const now = Math.floor(Date.now() / 1000);

    // 转换比赛数据为标准格式
    return response.currentData.contests.result.map(contest => {
      const startTime = contest.startTime;
      const endTime = contest.endTime;

      // 根据当前时间确定比赛阶段
      let phase = 'upcoming';
      if (now > endTime) phase = 'ended';
      else if (now > startTime) phase = 'coding';

      return {
        name: contest.name,
        startTime,
        duration: endTime - startTime,
        phase,
        url: `https://www.luogu.com.cn/contest/${contest.id}`
      };
    });
  } catch (error) {
    console.error('Error occurs when fetching Luogu contests :(', error);
    return [];
  }
}

// ai 改的代码比我写的 bug 还多，sad
import { Context, Schema } from 'koishi'
import * as cheerio from 'cheerio';

export const name = 'oi-contest-sniffer'

export interface Config {
  defaultMaxContests: number,
  startSearchFrom: number,
  timeout: number,
  greetings: string[],
  platformAliases: Record<string, string>,
  statusText: {
    upcoming: string,
    coding: string,
    ended: string
  }
}

export const Config: Schema<Config> = Schema.object({
  defaultMaxContests: Schema.number()
    .min(1).max(30)
    .default(5)
    .description('默认返回比赛数量'),

  startSearchFrom: Schema.number()
    .min(-15).max(15)
    .default(0)
    .description('从（  ）天前存在的比赛开始查询（不查询太过久远的比赛），可以取非正数。比如取 0 表示只查询未结束的比赛'),


  timeout: Schema.number()
    .min(1000).max(60000)
    .default(10000)
    .description('比赛数据请求超时阈值（单位毫秒）'),

  greetings: Schema.array(String)
    .default([
      '还在打OI哦，休息一下吧 ♪(´▽｀)',
      '今日宜：AK',
      'ο(=•ω＜=)ρ⌒☆',
      '想打比赛吗？那就来吧！(o゜▽゜)o☆',
      '今天你开long long了吗 ( •̀ ω •́ )',
      '唉你们OIer好可怕 O_O',
    ])
    .description('自定义问候语列表，每次随机选择一条显示在查询结果顶部'),

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
    .description('平台别名设置，在指定 -p 参数时可简化平台名称输入')
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
    .description('比赛状态显示文本')
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
  ctx.command('oi', '获取近期的 OI 线上赛事的日程')
    .usage('查询近期的 OI 线上赛事，支持多种筛选条件')
    .example('查询近期所有比赛（默认）：\n  oi')
    .example('查询在今天举办的，已经结束的所有比赛：\n  oi -d today -s ended')
    .example('查询 2025 年 1 月 1 日在 Codeforces 举办的比赛，只输出在查询时刻尚未开始的前 3 场比赛：\n  oi -p cf -d 2025-01-01 -s upcoming -n 3')
    .option('platform', '-p <platform> 筛选比赛平台，可用字段参见 platformAliases 设置')
    .option('phase', '-s <phase> 筛选比赛阶段 (支持 "upcoming", "coding", "ended" 三种参数)')
    .option('count', '-n <count> 限制一次性输出的比赛总数')
    .option('date', '-d <date> 查询最近指定日期的比赛（格式：YYYY-MM-DD，比如 2025-01-01，只能输入最近的日期）')
    .action(async ({ session, options }) => {
      // try-catch 太 ai 了，不过 ai 说的道理
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
    getCodeforcesContests(ctx, config),
    getAtcoderContests(ctx, config),
    getLuoguContests(ctx, config),
  ]);

  // 合并同类项，标记比赛来源方便后期筛选
  const allContests = [
    ...cfContests.map(c => ({ ...c, platform: 'Codeforces' })),
    ...atcoderContests.map(c => ({ ...c, platform: 'AtCoder' })),
    ...luoguContests.map(c => ({ ...c, platform: 'Luogu' })),
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
    // 输入的参数转换为小写（不区分是对的）
    const inputPlatform = options.platform.toLowerCase();

    // 查找匹配的别名 / 正式名称
    let matchedPlatform = null;
    for (const [alias, platform] of Object.entries(config.platformAliases)) {
      if (alias.toLowerCase() === inputPlatform) {
        matchedPlatform = platform;
        break;
      }
    }

    // 否则尝试直接匹配正式名称
    if (!matchedPlatform) {
      for (const platform of Object.values(config.platformAliases)) {
        if (platform.toLowerCase() === inputPlatform) {
          matchedPlatform = platform;
          break;
        }
      }
    }

    // 如果找到匹配的平台名称
    if (matchedPlatform) {
      processed = processed.filter(c => c.platform === matchedPlatform);
    } else {
      // 如果没有匹配的平台，返回空数组表示找不到
      return [];
    }
  }

  // 比赛阶段筛选（-s 参数）
  if (options.phase) {
    processed = processed.filter(c =>
      c.phase.toLowerCase().includes(options.phase.toLowerCase())
    );
  }

  // 日期筛选（-d 参数）
  if (options.date) {
    let targetDate: Date | null = null;
    try {
      if (options.date.toLowerCase() === 'today') {
        targetDate = new Date();
      } else {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (dateRegex.test(options.date)) {
          targetDate = new Date(options.date);
          if (isNaN(targetDate.getTime())) {
            targetDate = null;
          }
        }
      }
      if (targetDate) {
        processed = processed.filter(contest => {
          if (!contest.startTime) return false;
          const contestDate = new Date(contest.startTime * 1000);
          return (
            contestDate.getFullYear() === targetDate.getFullYear() &&
            contestDate.getMonth() === targetDate.getMonth() &&
            contestDate.getDate() === targetDate.getDate()
          );
        });
      }
    } catch (e) {
      console.log('Invalid date format! -d option ignored!');
    }
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
  return processed.slice(0, options.count || config.defaultMaxContests);
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
    } else if (contest.phase.includes('coding')) {
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

// SubFunc: 获取 Codeforces 比赛，通过 API 获取
async function getCodeforcesContests(ctx: Context, config: Config): Promise<Contest[]> {
  try {
    // 请求Codeforces API获取比赛列表
    const response = await ctx.http.get('https://codeforces.com/api/contest.list', {
      params: { gym: false },
      timeout: config.timeout,
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

// SubFunc: 获取 Atcoder 比赛，利用 cheerio 爬取网站（无官方 API）
// 纯 ai 写的，我不会用 cheerio
async function getAtcoderContests(ctx: Context, config: Config): Promise<Contest[]> {
  try {
    // 获取AtCoder比赛页面HTML
    const html = await ctx.http.get('https://atcoder.jp/contests', {
      timeout: config.timeout,
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
async function getLuoguContests(ctx: Context, config: Config): Promise<Contest[]> {
  try {
    const response = await ctx.http.get('https://www.luogu.com.cn/contest/list?_contentOnly=1', {
      timeout: config.timeout,
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

// SubFunc: 获取 LeetCode 国内站比赛，使用官方 API
// LeetCode 爬取信息需要cookie，并且大多时候只有固定的单周赛与双周赛，所以删了

// 话说 ai 为啥这么喜欢 try-catch
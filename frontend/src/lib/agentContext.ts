/**
 * 给 Agent 攒上下文。
 *
 * 原则是**只传摘要，不传全量**。整个 project JSON 塞进去很贵（一个十几轨的项目
 * 光 take 历史就上千行），而 Agent 需要知道的只是「有哪些乐器、生成了没有、
 * 现在在哪一页」。用户真要问细节，那时再说。
 *
 * 课程也一样：`standard` 那一栏是每课的教学价值所在，必须传；`points`/`pitfalls`
 * 加起来太长，只在用户正停在某一课时才带上那一课的完整内容。
 */

import type { AgentContext } from "./api";
import { totalDuration } from "./formation";
import { findLesson, LESSONS } from "./teaching/curriculum";
import type { PageId } from "../state/store";
import type { Project } from "./api";

const PAGE_NAMES: Record<PageId, string> = {
  // 停在首页多半是刚打开软件，问的会是「这东西能干什么」而不是某个具体操作
  home: "首页（还没进入任何一条路径）",
  teach: "指挥教学 / 课程列表",
  "teach-lesson": "指挥教学 / 课程详情",
  "teach-exam": "指挥教学 / 考试",
  file: "指挥体验 / 文件",
  formation: "指挥体验 / 构型",
  generate: "指挥体验 / 生成",
  browse: "指挥体验 / 浏览",
  output: "指挥体验 / 输出（指挥）",
  train: "训练",
  settings: "设置",
};

function curriculumDigest(activeLessonId: string | null) {
  const digest = LESSONS.map((l) => ({
    单元: l.unit,
    课程: l.title,
    目标: l.goal,
    标准依据: l.standard,
    拍号: l.meters.length ? l.meters.map((m) => `${m}/4`).join("/") : "无",
  }));
  const active = findLesson(activeLessonId);
  if (!active) return { 课程列表: digest };
  return {
    课程列表: digest,
    // 用户正在看的这一课给全量 —— 他多半就是在问眼前这一课
    当前课程: {
      标题: active.title,
      目标: active.goal,
      标准依据: active.standard,
      要点: active.points,
      常见错误: active.pitfalls,
    },
  };
}

function projectDigest(project: Project | null) {
  if (!project) return "还没有打开任何项目";
  return {
    名称: project.name,
    总时长秒: totalDuration(project),
    调性: project.key,
    拍号: project.time_signature,
    BPM: project.bpm,
    有构型: !!project.formation,
    乐器: project.instruments.map((i) => ({
      名称: i.display_name,
      声部: i.role,
      已生成: !!i.current_take_id,
      take数: i.takes.length,
    })),
  };
}

export function buildAgentContext(
  page: PageId,
  project: Project | null,
  activeLessonId: string | null,
): AgentContext {
  return {
    curriculum: curriculumDigest(page === "teach-lesson" ? activeLessonId : null),
    state: {
      当前页面: PAGE_NAMES[page],
      项目: projectDigest(project),
    },
  };
}

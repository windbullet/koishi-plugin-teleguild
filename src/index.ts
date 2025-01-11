import { time } from 'console'
import { Context, Schema, Session, Tables, h } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

export const name = 'teleguild'

declare module 'koishi' {
  interface Tables {
    teleguild_protals_auto: Portal
    teleguild_protals_manual: Portal
  }
}

export interface Portal {
  callId: number
  id: string
  name: string
}

interface Guilds {
  [guildId: string]: string
}

interface Messages {
  [messageId: string]: string
}

interface activeGuilds {
  id: string
  name: string
}

export interface Config {
  showGuildId: boolean
  limit: '不限制' | '限制时间' | '限制消息量' | '限制时间或消息量（其中之一达到就结束）'
  timeLimit?: number
  countLimit?: number
  autoGuilds: boolean
  activeGuilds?: activeGuilds[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    showGuildId: Schema.boolean()
      .default(false)
      .description('是否在通讯录和来电提示中显示群号'),
  }),
  Schema.intersect([
    Schema.object({
      limit: Schema.union(["不限制", "限制时间", "限制消息量", "限制时间或消息量（其中之一达到就结束）"])
        .default("不限制")
        .description('限制通话的时间或消息量'),
    }),
    Schema.union([
      Schema.object({
        limit: Schema.const("限制时间").required(),
        timeLimit: Schema.number().description("通话时间上限(s)").required(),
      }),
      Schema.object({
        limit: Schema.const("限制消息量").required(),
        countLimit: Schema.number().description("通话消息量上限").required(),
      }),
      Schema.object({
        limit: Schema.const("限制时间或消息量（其中之一达到就结束）").required(),
        timeLimit: Schema.number().description("通话时间上限(s)").required(),
        countLimit: Schema.number().description("通话消息量上限").required(),
      }),
      Schema.object({
        limit: Schema.const("不限制")
      })
    ])
  ]),
  Schema.intersect([
    Schema.object({
      autoGuilds: Schema.boolean()
      .default(true)
      .description('自动获取bot所在的所有群列表添入通讯录'),
    }),
    Schema.union([
      Schema.object({
        autoGuilds: Schema.const(false).required(),
        activeGuilds: Schema.array(Schema.object({
          id: Schema.string().description("群号").required(),
          name: Schema.string().description("群名").required(),
        })).description("显示在通讯录的群列表").role("table")
      }),
      Schema.object({
        autoGuilds: Schema.const(true)
      })
    ])
  ])
])

export const inject = ["puppeteer", "database"]

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('teleguild_protals_auto', {
    callId: "unsigned",
    id: "string",
    name: "string"
  }, { primary: 'callId', autoInc: true })

  ctx.model.extend('teleguild_protals_manual', {
    callId: "unsigned",
    id: "string",
    name: "string"
  }, { primary: 'callId', autoInc: true })

  let guilds: Guilds = {}

  let messages: Messages = {}

  ctx.command("群互通", "群消息互通")

  ctx.command("群互通.发起 <guildId:posint>", "向指定群发起群消息互通，ID可在“群互通.通讯录”中查看")
    .example("群互通.发起 114")
    .action(async ({ session }, guildId) => {
      if (guildId == undefined) {
        await session.send("未输入群号")
        await session.execute("群互通.通讯录")
        return
      }

      let initiatorGuildId = session.guildId
      let dbName = config.autoGuilds ? "teleguild_protals_auto" : "teleguild_protals_manual"

      let guild = await ctx.database.get(dbName as any, { callId: guildId })

      if (guild.length === 0) {
        guild = await ctx.database.get(dbName as any, { id: guildId })
        if (guild.length === 0) {
          return "群ID不存在或缓存未刷新，请使用“群互通.通讯录”后重试"
        }
      }

      let targetGuildId = guild[0].id

      if (guilds[initiatorGuildId]) return "你所在的群正在通话中"
      if (guild[0].id === initiatorGuildId) return "不能给自己打电话"
      if (guilds[targetGuildId]) return "对方群正在通话中，请稍后再试"

      guilds[targetGuildId] = initiatorGuildId
      guilds[initiatorGuildId] = targetGuildId

      await session.bot.sendMessage(targetGuildId, `群聊“${session.event.guild.name}”${config.showGuildId ? `(${initiatorGuildId})` : ""}向本群发起了消息互通请求，请在30秒内发送“接通”或“挂断”`)
      session.bot.sendMessage(initiatorGuildId, `${h.quote(session.messageId)}已发起群消息互通请求`)

      let disposeYesOrNo = ctx.guild(targetGuildId).on('message', async (session) => {
        if (session.content === "挂断") {
          disposeTimeout()
          hangUp()
          await session.bot.sendMessage(targetGuildId, `${h.quote(session.messageId)}已挂断`)
          await session.bot.sendMessage(initiatorGuildId, `${h.quote(session.messageId)}已被对方挂断`)
        } else if (session.content === "接通") {
          disposeTimeout()
          answer()
        }
      })

      let disposeTimeout = ctx.setTimeout(async () => {
        hangUp()
        await session.bot.sendMessage(targetGuildId, `通话请求回应超时，已自动挂断`)
        await session.bot.sendMessage(initiatorGuildId, `${h.quote(session.messageId)}通话请求回应超时，已自动挂断`)
      }, 30000)

      function answer() {
        disposeYesOrNo()
        let msg = `通话已接通，任何群员都可以发送“挂断”结束通话`
        if (config.limit === "限制时间") {
          msg += `，通话时间上限为${config.timeLimit}秒`
        } else if (config.limit === "限制消息量") {
          msg += `，通话消息量上限为${config.countLimit}条`
        } else if (config.limit === "限制时间或消息量（其中之一达到就结束）") {
          msg += `，通话消息量上限为${config.countLimit}条，通话时间上限为${config.timeLimit}秒`
        }
        session.bot.sendMessage(initiatorGuildId, `${h.quote(session.messageId)}${msg}`)
        session.bot.sendMessage(targetGuildId, msg)

        let disposeGuild1 = ctx.guild(targetGuildId).on('message', async (session) => {
          if (session.content === "挂断") {
            hangUpWithMessage(targetGuildId)
          } else {
            await relayMessage(session, initiatorGuildId)
          }
        })

        let disposeGuild2 = ctx.guild(initiatorGuildId).on('message', async (session) => {
          if (session.content === "挂断") {
            hangUpWithMessage(initiatorGuildId)
          } else {
            await relayMessage(session, targetGuildId)
          }
        })

        let disposeMaxTime: () => void

        let relayMessage: (session: Session<never, never, Context>, guildId: string) => Promise<void>

        if (config.limit === "限制时间") {
          timeLimit()
        } else if (config.limit === "限制消息量") {
          messageLimit()
        } else if (config.limit === "限制时间或消息量（其中之一达到就结束）") {
          timeLimit()
          messageLimit()
        } else {
          relayMessage = async (session: Session<never, never, Context>, guildId: string) => {
            let content = ""
            let date = new Date()
            if (messages[session?.quote?.id] !== undefined) {
              content += h.quote(messages[session.quote.id])
            }
            content += `[${session.username} ${("00" + date.getHours()).slice(-2)}:${("00" + date.getMinutes()).slice(-2)}:${("00" + date.getSeconds()).slice(-2)}]<br/>`
            content += session.content
            messages[(await session.bot.sendMessage(guildId, content))[0]] = session.messageId
          }
        }

        let disposeTip = ctx.setInterval(() => {
          session.bot.sendMessage(initiatorGuildId, `任何群友都可以发送“挂断”结束当前通话哦`)
          session.bot.sendMessage(targetGuildId, `任何群友都可以发送“挂断”结束当前通话哦`)
        }, 120000)

        function timeLimit() {
          disposeMaxTime = ctx.setTimeout(() => {
            disposeGuild1()
            disposeGuild2()
            disposeTip()
            delete guilds[targetGuildId]
            delete guilds[initiatorGuildId]
            session.bot.sendMessage(initiatorGuildId, `时间到达上限，已挂断通话`)
            session.bot.sendMessage(targetGuildId, `时间到达上限，已挂断通话`)
          }, config.timeLimit * 1000)
        }

        function messageLimit() {
          let messageCount = 0
          relayMessage = async (session: Session<never, never, Context>, guildId: string) => {
            let content = ""
            let date = new Date()
            if (messages[session?.quote?.id] !== undefined) {
              content += h.quote(messages[session.quote.id])
            }
            content += `[${session.username} ${("00" + date.getHours()).slice(-2)}:${("00" + date.getMinutes()).slice(-2)}:${("00" + date.getSeconds()).slice(-2)}]<br/>`
            content += session.content
            messageCount++
            if (messageCount >= config.countLimit) {
              disposeGuild1()
              disposeGuild2()
              disposeTip()
              if (disposeMaxTime !== undefined) disposeMaxTime()
              delete guilds[targetGuildId]
              delete guilds[initiatorGuildId]
              await session.bot.sendMessage(guildId, content)
              session.bot.sendMessage(initiatorGuildId, `消息量到达上限，已挂断通话`)
              session.bot.sendMessage(targetGuildId, `消息量到达上限，已挂断通话`)
            } else {
              messages[(await session.bot.sendMessage(guildId, content))[0]] = session.messageId
            }
          }
        }

        async function hangUpWithMessage(id: string) {
          disposeGuild1()
          disposeGuild2()
          disposeTip()
          if (disposeMaxTime !== undefined) disposeMaxTime()
          session.bot.sendMessage(id, `通话已挂断`)
          session.bot.sendMessage(guilds[id], `${h.quote(session.messageId)}对方已挂断`)
          delete guilds[targetGuildId]
          delete guilds[initiatorGuildId]
        }
      }

      function hangUp() {
        disposeYesOrNo()
        delete guilds[targetGuildId]
        delete guilds[initiatorGuildId]
      }

    })

  ctx.command("群互通.通讯录", "查看群通讯录")
    .action(async ({ session }) => {
      let dbName: string

      if (config.autoGuilds) {
        dbName = "teleguild_protals_auto"
        let guilds = []
        for await (let guild of session.bot.getGuildIter()) {
          guilds.push(guild)
        }
        await ctx.database.upsert("teleguild_protals_auto", guilds, ["id", "name"])
      } else {
        dbName = "teleguild_protals_manual"
        await ctx.database.upsert("teleguild_protals_manual", config.activeGuilds, ["id", "name"])
      }

      let rows = []
      if (config.showGuildId) {
        for (let guild of await ctx.database.get(dbName as any, {})) {
          rows.push("<tr>")
          rows.push(`<td>${guild.callId}</td>`)
          rows.push(`<td>${guild.name}</td>`)
          rows.push(`<td>${guild.id}</td>`)
          rows.push("</tr>")
        }
      } else {
        for (let guild of await ctx.database.get(dbName as any, {})) {
          rows.push("<tr>")
          rows.push(`<td>${guild.callId}</td>`)
          rows.push(`<td>${guild.name}</td>`)
          rows.push("</tr>")
        }
      }

      return await ctx.puppeteer.render(
        `<html style="width: fit-content">
          <head>
            <style>
              th {
                background:#f3f3f3 !important;
              }
            </style>
          </head>
        
          <body style="height: fit-content; min-height: 50%">
            <table border="1" cellpadding="5" style="margin: 10px; border-collapse: collapse">
              <tbody align="center" valign="center">
                <tr>
                  <th>ID</th>
                  <th>群名</th>
                  ${config.showGuildId ? "<th>群号</th>" : ""}
                </tr>
                ${rows.join("\n")}
              </tbody>
            </table>
          </body>
        </html>`)
    })
}

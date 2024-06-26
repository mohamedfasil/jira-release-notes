/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-require-imports */
import * as core from '@actions/core'
import * as child from 'child_process'
const nodemailer = require('nodemailer')

import Jira from './jira'

const transporter = (host, port = 587, secure = false, username, password) =>
  nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: username,
      pass: password
    }
  })

const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
  <style>
    table {
      font-family: arial, sans-serif;
      border-collapse: collapse;
      width: 100%;
    }

    td, th {
      border: 1px solid #dddddd;
      text-align: left;
      padding: 8px;
    }
  </style>
</head>
<body>
  <% if (Object.values(validTicketsList).length > 0) { %>
    <% Object.values(validTicketsList).forEach((issueTypeDetails) => { %>
      <table>
        <thead>
          <tr>
            <th>Issue Type</th>
            <th>JIRA Ticket</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          <% issueTypeDetails.data.forEach((jiraTicketDetails) => { %>
            <tr>
              <td><%= jiraTicketDetails[0] %></td>
              <td><%= jiraTicketDetails[1] %></td>
              <td><%= jiraTicketDetails[2] %></td>
            </tr>
          <% }); %>
        </tbody>
      </table>
      <br/>
      <br/>
    <% }); %>
  <% } else { %>
    <p>No data available.</p>
  <% } %>
</body>
</html>
`

const template = `


Jira Tickets
---------------------
<% tickets.all.forEach((ticket) => { %>
  * [<%= ticket.fields.issuetype.name %>] - [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>) <%= ticket.fields.summary -%>
<% }); -%>
<% if (!tickets.all.length) {%> ~ None ~ <% } %>

Other Commits
---------------------
<% commits.noTickets.forEach((commit) => { %>
  * <%= commit.authorName %> - [<%= commit.revision.substr(0, 7) %>] - <%= commit.summary -%>
<% }); -%>
<% if (!commits.noTickets.length) {%> ~ None ~ <% } %>

`

const getValidJiraTickets = (ticketList, jiraConfig) => {
  let jiraTickets = {}
  Object.values(ticketList).forEach((ticket: any) => {
    const issuetype = ticket.fields.issuetype.name
      ?.replace(/\W/g, '-')
      ?.toLowerCase()
    if (!jiraTickets[issuetype]) {
      jiraTickets[issuetype] = {key: issuetype, data: []}
    }
    jiraTickets[issuetype].data = [
      ...jiraTickets[issuetype].data,
      [issuetype, `${jiraConfig.baseUrl}/browse/${ticket.key}`, ticket.fields.summary]
    ]
  })

  const bugIssueType = jiraTickets['bug']
  if (bugIssueType) {
    delete jiraTickets['bug']
    jiraTickets['bug']= bugIssueType;
  }

  return jiraTickets;
}

const sendMail = async (triggerMail, fromMail, toMail, emailHtmlTempalate) => {
  try {
    await triggerMail.sendMail({
      from: fromMail,
      to: toMail,
      subject: 'JIRA Release Notes',
      html: emailHtmlTempalate
    })
  } catch (e) {
    console.log('error in triggering mail', e)
  }
}

async function run(): Promise<void> {
  try {
    const RegExpFromString = require('regexp-from-string')

    const base: string = core.getInput('base_branch')
    const release: string = core.getInput('release_branch')
    const smtpHost: string = core.getInput('smtp_host')
    const smtpPort: number = parseInt(core.getInput('smtp_port'))
    const smtpUsername: string = core.getInput('smtp_username')
    const smtpPassword: string = core.getInput('smtp_password')
    const fromMail: string = core.getInput('from_mail')
    const toMail: string = core.getInput('to_mail')
    const triggerMail = transporter(
      smtpHost,
      smtpPort,
      false,
      smtpUsername,
      smtpPassword
    )

    const jiraConfig = {
      host: core.getInput('jira_host'),
      email: core.getInput('jira_email'),
      token: core.getInput('jira_token'),
      baseUrl: core.getInput('jira_base_url'),
      ticketIDPattern: RegExpFromString(core.getInput('jira_ticket_id_pattern'))
    }
    child.exec(`git log ${base}..${release}`, async (err, stdout) => {
      if (err) {
        core.setFailed(err.message)
      } else {
        core.debug(`The stdout from git log: ${stdout.toString()}`)
        const {SourceControl} = require('jira-changelog')
        const source = new SourceControl(jiraConfig)
        const range = {
          from: release,
          to: base
        }

        const jira = new Jira(jiraConfig)
        core.debug(`Getting range ${range.from}...${range.to} commit logs`)
        const commitLogs = await source.getCommitLogs('./', range)
        const changelog = await jira.generate(commitLogs)
        const data = await transformCommitLogs(changelog, jiraConfig)
        const ejs = require('ejs')
        const shouldEmailBeTriggered =
          smtpUsername && smtpPassword && fromMail && toMail
        const Entities = require('html-entities')
        const ticketsTemplate = shouldEmailBeTriggered
          ? emailTemplate
          : template
        const table = ejs.render(ticketsTemplate, data)
        const entitles = new Entities.AllHtmlEntities()
        const finalTemplate = entitles.decode(table)
        console.log('Changelog message entry:')
        console.log(entitles.decode(table))
        if (shouldEmailBeTriggered) {
          sendMail(triggerMail, fromMail, toMail, finalTemplate)
        }
        core.setOutput('changelog_message', table)
      }
    })
    core.debug(`Base brnach ${base}; base branch ${release}`)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function transformCommitLogs(logs, jiraConfig) {
  // Tickets and their commits
  const _ = require('lodash')
  const ticketHash = logs.reduce((all, log) => {
    log.tickets.forEach(ticket => {
      all[ticket.key] = all[ticket.key] || ticket
      all[ticket.key].commits = all[ticket.key].commits || []
      all[ticket.key].commits.push(log)
    })
    return all
  }, {})

  const ticketList = _.sortBy(
    Object.values(ticketHash),
    ticket => ticket.fields.issuetype.name
  )

  const validTicketsList = getValidJiraTickets(ticketList, jiraConfig)

  return {
    commits: {
      all: logs,
      tickets: logs.filter(commit => commit.tickets.length),
      noTickets: logs.filter(commit => !commit.tickets.length)
    },
    tickets: {
      all: ticketList
    },
    jira: jiraConfig,
    validTicketsList
  }
}

run()
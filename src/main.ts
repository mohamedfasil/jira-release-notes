import * as core from '@actions/core'
import * as child from 'child_process'

import Jira from './jira'

async function run(): Promise<void> {
  try {
    const RegExpFromString = require('regexp-from-string')

    const base: string = core.getInput('base_branch') || 'origin/master'
    const release: string =
      core.getInput('release_branch') || 'origin/release-21jun-pwa'
    const jiraConfig = {
      host: core.getInput('jira_host') || 'asiatvusa.atlassian.net',
      email: core.getInput('jira_email') || 'mohamed.fasil@zee.com',
      token:
        core.getInput('jira_token') ||
        'ATATT3xFfGF08nfVrC0fSBLGw2p9B29_1B-NdYNf1Rcc3ERuvPnBOGo75dhT0UkfjjWNIlBDQH8kNU22ifXvdXfkqURvi9XJWCI3ONqvXVTXD71D-j05dRSdjkwFcbjx4Vv2FF83Icn8U4jYAmlsNCNlDpE1qAwI8kc7lsCbzECbp9e_l_iHtQo=FD7721E6',
      baseUrl:
        core.getInput('jira_base_url') || 'https://asiatvusa.atlassian.net',
      ticketIDPattern: RegExpFromString(
        core.getInput('jira_ticket_id_pattern') || '/([A-Z]+-[0-9]+)/i'
      )
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
        //core.debug(commitLogs)
        jira.generate(commitLogs, '1.0.0')
      }
    })
    core.debug(`Base brnach ${base}; base branch ${release}`)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()

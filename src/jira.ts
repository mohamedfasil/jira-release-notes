import 'core-js/stable'
import 'regenerator-runtime/runtime'
import JiraApi from 'jira-client'
import PromiseThrottle from 'promise-throttle'

const promiseThrottle = new PromiseThrottle({
  requestsPerSecond: 10,
  promiseImplementation: Promise
})

/**
 * Generate changelog by matching source control commit logs to jiar tickets.
 */
type JiraConfig = {
  host: string
  email: string
  token: string
  baseUrl: string
  ticketIDPattern: RegExp
}
export default class Jira {
  config: JiraConfig
  releaseVersions = []
  ticketPromises = {}
  jira
  constructor(config: JiraConfig) {
    this.config = config
    this.jira = undefined

    const {host, email, token} = config

    if (config.host) {
      this.jira = new JiraApi({
        host,
        username: email,
        password: token,
        protocol: 'https',
        strictSSL: false,
        apiVersion: '2' // forcing api version 2 to avoid breaking code by using different api version
      })
    } else {
      console.error(
        'ERROR: Cannot configure Jira without a host configuration.'
      )
    }
  }

  /**
   * Generate changelog by matching source control commit logs to jira tickets
   * and, optionally, creating the release version.
   *
   * @param {Array} commitLogs - A list of source control commit logs.
   * @param {String} releaseVersion - The name of the release version to create.
   * @return {Object}
   */
  async generate(commitLogs, releaseVersion = null) {
    const logs = []
    this.releaseVersions = []
    try {
      const promises = commitLogs.map(commit =>
        this.findJiraInCommit(commit)
          .then(log => {
            logs.push(log)
          })
          .catch(e => {
            console.error(e)
          })
      )
      promises.push(Promise.resolve()) // ensure at least one
      await Promise.all(promises)

      // Get all Jira tickets (filter out duplicates by keying on ID)
      let ticketsHash = {}
      let ticketsList = []
      logs.forEach(log => {
        log.tickets.forEach(ticket => (ticketsHash[ticket.id] = ticket))
      })
      ticketsList = Object.keys(ticketsHash).map(k => ticketsHash[k])

      // If there are Jira tickets, create a release for them
      /* if (ticketsList.length && releaseVersion) {
        return this.addTicketsToReleaseVersion(
          ticketsList,
          releaseVersion
        ).then(() => logs)
      } */

      return logs
    } catch (e) {
      throw new Error(e)
    }
  }

  /**
   * Find JIRA ticket numbers in a commit log, and automatically load the
   * ticket info for it.
   *
   * @param {Object} commitLog - Commit log object
   * @param {String} releaseVersion - Release version eg, mobileweb-1.8.0
   * @return {Promsie} Resolves to an object with a jira array property
   */
  async findJiraInCommit(commitLog) {
    const log = Object.assign({tickets: []}, {...commitLog})
    const promises = []
    const found = {}

    // Search for jira ticket numbers in the commit text
    const ticketKeys = this.parseTicketsFromString(log.fullText)
    ticketKeys.forEach(key => {
      // Skip loading if we're loading this one
      if (found[key]) {
        return
      }
      found[key] = true

      promises.push(
        this.fetchJiraTicket(key).catch(() => {}) // ignore errors
      )
    })

    // Add jira tickets to log
    const tickets = await Promise.all(promises)
    log.tickets = tickets.filter(t => t && this.includeTicket(t))

    return log
  }

  /**
   * Load a Jira issue ticket from the API.
   *
   * @param {String} ticketKey - The Jira ticket ID key
   *
   * @return {Promise}
   */
  fetchJiraTicket(ticketKey) {
    if (!ticketKey) {
      return Promise.resolve()
    }

    // Get Jira issue ticket object
    let promise = this.ticketPromises[ticketKey]
    if (!promise) {
      promise = promiseThrottle.add(this.getJiraIssue.bind(this, ticketKey))
      promise.catch(() => {
        console.log(`Ticket ${ticketKey} not found`)
      })
      this.ticketPromises[ticketKey] = promise
    }

    return promise
  }

  /**
   * Creates a release version and assigns tickets to it.
   *
   * @param {Array} ticket - List of Jira ticket objects
   * @param {String} versionName - The name of the release version to add the ticket to.
   * @return {Promise}
   */
  async addTicketsToReleaseVersion(tickets, versionName) {
    const versionPromises = {}
    this.releaseVersions = []

    // Create version and add it to a ticket
    async function updateTicketVersion(ticket) {
      const project = ticket.fields.project.key

      // Create version on project
      let verPromise = versionPromises[project]
      if (!verPromise) {
        verPromise = this.createProjectVersion(versionName, project)
        versionPromises[project] = verPromise

        // Add to list of releases
        verPromise.then(ver => {
          ver.projectKey = project
          this.releaseVersions.push(ver)
        })
      }

      // Add version to ticket
      const versionObj = await verPromise
      const {fixVersions} = ticket.fields
      fixVersions.push({name: versionObj.name})

      const result = await this.jira.updateIssue(ticket.id, {
        fields: {fixVersions}
      })
      return result
    }

    // Loop through tickets and throttle the promises.
    const promises = tickets.map(ticket => {
      return promiseThrottle
        .add(updateTicketVersion.bind(this, ticket))
        .catch(err => {
          if (err instanceof Error) {
            console.log(err)
          } else {
            console.log(JSON.stringify(err, null, '  '))
          }
          console.log(
            `Could not assign ticket ${ticket.key} to release '${versionName}'!`
          )
        })
    })
    return Promise.all(promises)
  }

  /**
   * Add a version to a single project, if it doesn't current exist
   * @param {String} versionName - The version name
   * @param {Array} projectKey - The project key
   * @return {Promise<String>} Resolves to version name string, as it exists in JIRA
   */
  async createProjectVersion(versionName, projectKey) {
    let searchName = versionName.toLowerCase()
    const versions = await this.jira.getVersions(projectKey)

    const exists = versions.find(v => v.name.toLowerCase() == searchName)
    if (exists) {
      return exists
    }

    const result = await this.jira.createVersion({
      name: versionName,
      project: projectKey
    })
    return result
  }

  /**
   * Retreive the jira issue by ID.
   *
   * @param {String} ticketId - The ticket ID of the issue to retrieve.
   * @return {Promise} Resolves a jira issue object, with added `slackUser` property.
   */
  async getJiraIssue(ticketId) {
    if (!this.jira) {
      return Promise.reject('Jira is not configured.')
    }
    console.log(ticketId)

    return this.jira
      .findIssue(ticketId)
      .then(origTicket => {
        const ticket = Object.assign({}, origTicket)
        console.log({origTicket})
        return ticket
      })
      .catch(err => console.error(err))
  }

  /**
   * Should ticket be included in changelog
   * @param   {Object} ticket - Jira ticket object
   * @returns {Boolean}
   */
  includeTicket(ticket) {
    if (!ticket.fields) {
      return false
    }

    const type = ticket.fields.issuetype.name
    return true
  }

  /**
   * Parse the JIRA ticket keys embedded in a string.
   * @param   {Object} str - The string to parse them out of.
   * @returns {Array} List of tickets
   */
  parseTicketsFromString(str) {
    const configPattern = this.config.ticketIDPattern
    const searchPattern = new RegExp(
      configPattern.source,
      `${configPattern.flags || ''}g`
    )
    const matches = str.match(searchPattern) || []

    // Extract ticket from pattern
    return matches
      .map(match => {
        let key = match.match(configPattern)
        key = key.length > 1 ? key[1] : key[0]
        if (!key) {
          return null
        }
        return key.toUpperCase()
      })
      .filter(m => !!m)
  }
}

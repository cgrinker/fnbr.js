/* eslint-disable class-methods-use-this */
/* eslint-disable no-param-reassign */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-confusing-arrow */
/* eslint-disable no-restricted-syntax */
/* eslint-disable max-len */
/* eslint-disable no-console */
const { EventEmitter } = require('events');
const { createInterface } = require('readline');
const onExit = require('async-exit-hook');
const Authenticator = require('./auth.js');
const Xmpp = require('../XMPP');
const Http = require('../Util/http');
const Endpoints = require('../../resources/Endpoints.js');
const ClientUser = require('../Structures/ClientUser.js');
const Friend = require('../Structures/Friend.js');
const PendingFriend = require('../Structures/PendingFriend.js');
const User = require('../Structures/User');
const CreatorCode = require('../Structures/CreatorCode');
const Enums = require('../../enums');
const List = require('../Util/List');
const FriendMessage = require('../Structures/FriendMessage.js');
const Party = require('../Structures/Party.js');
const SentPartyInvitation = require('../Structures/SentPartyInvitation.js');
// eslint-disable-next-line no-unused-vars
const { ClientOptions, DeviceAuthCredentials } = require('../../resources/Constants');
// eslint-disable-next-line no-unused-vars
const PartyMessage = require('../Structures/PartyMessage.js');
// eslint-disable-next-line no-unused-vars
const FriendPresence = require('../Structures/FriendPresence.js');
// eslint-disable-next-line no-unused-vars
const PartyInvitation = require('../Structures/PartyInvitation.js');
// eslint-disable-next-line no-unused-vars
const PartyMember = require('../Structures/PartyMember.js');

/**
 * The main client
 * @extends {EventEmitter}
 */
class Client extends EventEmitter {
  /**
   * @param {ClientOptions} args Client options
   */
  constructor(args = {}) {
    super();
    /**
     * The config of the client
     * @type {ClientOptions}
     */
    this.config = Client.mergeDefault(ClientOptions, args);

    /**
     * Whether the client is ready or not
     * @type {boolean}
     */
    this.isReady = false;

    /**
     * The default party member meta of the client
     * @type {?Object}
     * @private
     */
    this.lastMemberMeta = this.config.memberMeta;

    /**
     * The user of the client
     * @type {?ClientUser}
     */
    this.user = undefined;

    /**
     * The party that the client is currently in
     * @type {?Party}
     */
    this.party = undefined;

    /**
     * The authentication manager of the client
     * @type {Authenticator}
     * @private
     */
    this.Auth = new Authenticator(this);
    /**
     * The HTTP manager of the client
     * @type {Http}
     * @private
     */
    this.Http = new Http(this);
    /**
     * The XMPP manager of the client
     * @type {Xmpp}
     * @private
     */
    this.Xmpp = new Xmpp(this);
    /**
     * The friends cache of the client's user
     * @type {List}
     */
    this.friends = new List();
    /**
     * The pending friends cache of the client's user
     * @type {List}
     */
    this.pendingFriends = new List();
    /**
     * The blocked friends cache of the client's user
     * @type {List}
     */
    this.blockedFriends = new List();

    /**
     * The client's party lock
     * Used for delaying all party-related xmpp events while changes to client's party are made
     * @typedef {Object} PartyLock
     * @property {boolean} active Indicates if the party lock is active
     * @property {function} wait Sleep until party lock is no longer active
     * @private
     */
    this.partyLock = {
      active: false,
      wait: () => new Promise((res) => {
        const waitInterval = setInterval(() => {
          if (!this.partyLock.active) {
            clearInterval(waitInterval);
            res();
          }
        }, 100);
      }),
    };

    /**
     * The client's reauthentication lock
     * Used for delaying all Http requests while the client is reauthenticating
     * @typedef {Object} ReauthLock
     * @property {boolean} active Indicates if the reauthentication lock is active
     * @property {function} wait Sleep until reauthentication lock is no longer active
     * @private
     */
    this.reauthLock = {
      active: false,
      wait: () => new Promise((res) => {
        const waitInterval = setInterval(() => {
          if (!this.reauthLock.active) {
            clearInterval(waitInterval);
            res();
          }
        }, 100);
      }),
    };

    /**
     * Parses an error
     * @param {Object|string} error The error to be parsed
     * @private
     */
    this.parseError = (error) => typeof error === 'object' ? JSON.stringify(error) : error;

    /**
     * Converts an object's keys to camel case
     * @param {Object} obj The object to be converted
     * @private
     */
    this.makeCamelCase = Client.makeCamelCase;

    onExit(async (callback) => {
      await this.logout();
      callback();
    });
  }

  // -------------------------------------GENERAL-------------------------------------

  /**
   * Initiates client's login process
   * @returns {Promise<void>}
   */
  async login() {
    const auth = await this.Auth.authenticate();
    if (!auth.success) throw new Error(`Authentification failed: ${this.parseError(auth.response)}`);

    this.tokenCheckInterval = setInterval(() => this.Auth.refreshToken(true), 20 * 60000);

    const clientInfo = await this.Http.send(false, 'GET', `${Endpoints.ACCOUNT_ID}/${this.Auth.account.id}`, `bearer ${this.Auth.auths.token}`);
    if (!clientInfo.success) throw new Error(`Client account lookup failed: ${this.parseError(clientInfo.response)}`);
    this.user = new ClientUser(this, clientInfo.response);

    this.Xmpp.setup();

    await this.updateCache();

    const xmpp = await this.Xmpp.connect();
    if (!xmpp.success) throw new Error(`XMPP-client connecting failed: ${this.parseError(xmpp.response)}`);

    await this.initParty();

    this.isReady = true;
    await this.waitForEvent(`party:member#${this.user.id}:joined`, 30000);
    this.emit('ready');
  }

  /**
   * Disconnects the client
   * @returns {Promise<void>}
   */
  async logout() {
    if (this.tokenCheckInterval) clearInterval(this.tokenCheckInterval);
    this.removeAllListeners();
    if (this.Xmpp.connected) await this.Xmpp.disconnect();
    if (this.party) await this.party.leave(false);
    if (this.Auth.auths.token) await this.Http.send(false, 'DELETE', `${Endpoints.OAUTH_TOKEN_KILL}/${this.Auth.auths.token}`, `bearer ${this.Auth.auths.token}`);

    this.Auth.auths.token = undefined;
    this.Auth.auths.expires_at = undefined;
    this.Auth.reauths.token = undefined;
    this.Auth.reauths.expires_at = undefined;

    this.isReady = false;
  }

  /**
   * Restarts the client
   * @returns {Promise<void>}
   */
  async restart() {
    if (this.tokenCheckInterval) clearInterval(this.tokenCheckInterval);
    if (this.Xmpp.connected) await this.Xmpp.disconnect();
    if (this.party) await this.party.leave(false);
    if (this.Auth.auths.token) await this.Http.send(false, 'DELETE', `${Endpoints.OAUTH_TOKEN_KILL}/${this.Auth.auths.token}`, `bearer ${this.Auth.auths.token}`);
    this.Auth.auths.token = undefined;
    this.Auth.auths.expires_at = undefined;
    this.isReady = false;

    await this.login();
  }

  /**
   * Refreshes the client's friends (including pending and blocked)
   * @returns {Promise<void>}
   * @private
   */
  async updateCache() {
    const [rawFriends, friendsSummary] = await Promise.all([
      this.Http.send(true, 'GET', `${Endpoints.FRIENDS}/public/friends/${this.user.id}?includePending=true`, `bearer ${this.Auth.auths.token}`),
      this.Http.send(true, 'GET', `${Endpoints.FRIENDS}/v1/${this.user.id}/summary?displayNames=true`, `bearer ${this.Auth.auths.token}`),
    ]);

    if (!rawFriends.success) throw new Error(`Cannot update friend cache: ${this.parseError(rawFriends.response)}`);
    if (!friendsSummary.success) throw new Error(`Cannot update friend cache: ${this.parseError(friendsSummary.response)}`);

    this.friends.clear();
    this.blockedFriends.clear();
    this.pendingFriends.clear();

    for (const rawFriend of rawFriends.response) {
      if (rawFriend.status === 'ACCEPTED') this.friends.set(rawFriend.accountId, rawFriend);
      else if (rawFriend.status === 'PENDING') this.pendingFriends.set(rawFriend.accountId, rawFriend);
      else if (rawFriend.status === 'BLOCKED') this.blockedFriends.set(rawFriend.accountId, rawFriend);
      else this.debug(rawFriend.status);
    }

    for (const friendedFriend of friendsSummary.response.friends) {
      const friend = this.friends.get(friendedFriend.accountId);
      this.friends.set(friendedFriend.accountId, new Friend(this, { ...friend, ...friendedFriend }));
    }

    for (const blockedFriend of friendsSummary.response.blocklist) {
      const friend = this.blockedFriends.get(blockedFriend.accountId);
      this.blockedFriends.set(blockedFriend.accountId, new Friend(this, { ...friend, ...blockedFriend, blocked: true }));
    }

    for (const incomingFriend of friendsSummary.response.incoming) {
      const friend = this.pendingFriends.get(incomingFriend.accountId);
      this.pendingFriends.set(incomingFriend.accountId, new PendingFriend(this, { ...friend, ...incomingFriend, direction: 'INCOMING' }));
    }
    for (const outgoingFriend of friendsSummary.response.outgoing) {
      const friend = this.pendingFriends.get(outgoingFriend.accountId);
      this.pendingFriends.set(outgoingFriend.accountId, new PendingFriend(this, { ...friend, ...outgoingFriend, direction: 'OUTGOING' }));
    }
  }

  /**
   * Initiates a party
   * @param {boolean} create Whether to create a new one after leaving the current one
   * @returns {Promise<void>}
   * @private
   */
  async initParty(create = true) {
    const party = await Party.LookupSelf(this);
    if (!create && party) this.party = party;
    else if (party) await party.leave(false);
    if (create || !party) await Party.Create(this);
  }

  // -------------------------------------UTIL-------------------------------------

  /**
   * Debug a message via the debug function provided in the client's config (if provided)
   * @param {string} message The message that will be debugged
   * @returns {void}
   * @private
   */
  debug(message) {
    if (this.config.debug) this.config.debug(message);
  }

  /**
   * Convert an object's keys to camel case
   * @param {Object} obj The object that will be converted
   * @returns {Object} The converted object
   * @private
   */
  static makeCamelCase(obj) {
    const returnObj = {};
    for (const key of Object.keys(obj)) {
      returnObj[key.split('_').map((s, i) => {
        if (i > 0) return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
        return s;
      }).join('')] = obj[key];
    }
    return returnObj;
  }

  /**
   * Sleep until an event is emitted
   * @param {string|symbol} event The event will be waited for
   * @param {number} [timeout=5000] The timeout (in milliseconds)
   * @param {function} [filter] The filter for the event
   * @returns {Promise<Object>}
   */
  waitForEvent(event, timeout = 5000, filter) {
    return new Promise((res, rej) => {
      this.once(event, (eventData) => {
        if (!filter || filter(eventData)) res(eventData);
      });
      setTimeout(() => rej(new Error('Event timeout exceed')), timeout);
    });
  }

  /**
   * Sleep for the provided milliseconds
   * @param {number} timeout The timeout (in milliseconds)
   * @returns {Promise<void>}
   * @private
   */
  static sleep(timeout) {
    return new Promise((res) => setTimeout(() => res(), timeout));
  }

  /**
   * Display a console prompt
   * @param {string} question The text that will be prompted
   * @returns {Promise<string>} The received answer
   * @private
   */
  static consoleQuestion(question) {
    const itf = createInterface(process.stdin, process.stdout);
    return new Promise((res) => itf.question(question, (answer) => {
      itf.close(); res(answer);
    }));
  }

  /**
   * Sleep until the client is ready
   * @param {number} [timeout=20000] The timeout (in milliseconds)
   */
  waitUntilReady(timeout = 20000) {
    return new Promise((res, rej) => {
      if (this.isReady) res();
      const waitInterval = setInterval(() => {
        if (this.isReady) {
          clearInterval(waitInterval);
          res();
        }
      }, 250);
      setTimeout(() => rej(new Error('Waiting for ready timeout exceed')), timeout);
    });
  }

  /**
   * Merges a default object with a given one
   * @param {Object} def The default object
   * @param {Object} given The given object
   * @returns {Object} The merged objects
   * @private
   */
  static mergeDefault(def, given) {
    if (!given) return def;
    for (const key in def) {
      if (!Object.prototype.hasOwnProperty.call(given, key) || given[key] === undefined) {
        given[key] = def[key];
      } else if (given[key] === Object(given[key])) {
        given[key] = Client.mergeDefault(def[key], given[key]);
      }
    }
    return given;
  }

  /**
   * Merges a default object with a given one
   * @param {Object} def The default object
   * @param {Object} given The given object
   * @returns {Object} The merged objects
   * @private
   */
  mergeDefault(def, given) {
    return Client.mergeDefault(def, given);
  }

  // -------------------------------------ACCOUNT-------------------------------------

  /**
   * Fetches an Epic Games account
   * @param {string|Array<string>} query The id, name or email of the account(s) you want to fetch
   * @returns {Promise<User>|Promise<Array<User>>} The fetched account(s)
   * @example
   * client.getProfile('aabbccddeeff00112233445566778899');
   */
  async getProfile(query) {
    let user;
    if (typeof query === 'string') {
      if (query.length === 32) user = await this.Http.send(true, 'GET', `${Endpoints.ACCOUNT_ID}/${query}`, `bearer ${this.Auth.auths.token}`);
      else if (/.*@.*\..*/.test(query)) user = await this.Http.send(true, 'GET', `${Endpoints.ACCOUNT_EMAIL}/${encodeURI(query)}`, `bearer ${this.Auth.auths.token}`);
      else user = await this.Http.send(true, 'GET', `${Endpoints.ACCOUNT_DISPLAYNAME}/${encodeURI(query)}`, `bearer ${this.Auth.auths.token}`);

      return user.success ? new User(this, user.response) : undefined;
    } if (query instanceof Array) {
      const ids = [];
      const names = [];
      const emails = [];

      for (const userQuery of query) {
        if (userQuery.length === 32) ids.push(userQuery);
        else if (/.*@.*\..*/.test(userQuery)) emails.push(userQuery);
        else names.push(userQuery);
      }

      const nameResults = (await Promise.all(names.map((name) => this.Http.send(true, 'GET', `${Endpoints.ACCOUNT_DISPLAYNAME}/${encodeURI(name)}`, `bearer ${this.Auth.auths.token}`))))
        .filter((name) => name.success).map((name) => new User(this, name.response));
      const emailResults = (await Promise.all(emails.map((email) => this.Http.send(true, 'GET', `${Endpoints.ACCOUNT_EMAIL}/${encodeURI(email)}`, `bearer ${this.Auth.auths.token}`))))
        .filter((email) => email.success).map((email) => new User(this, email.response));
      let idResults = await this.Http.send(true, 'GET', `${Endpoints.ACCOUNT_MULTIPLE}?accountId=${ids.join('&accountId=')}`, `bearer ${this.Auth.auths.token}`);
      if (idResults.success) idResults = idResults.response.map((idr) => new User(this, idr));
      else idResults = [];

      const results = [];
      nameResults.forEach((nr) => results.push(nr));
      emailResults.forEach((er) => results.push(er));
      idResults.forEach((ir) => results.push(ir));

      return results;
    } throw new TypeError(`${typeof query} is not a valid account query type`);
  }

  /**
   * Changes the presence status
   * @param {string} [status] The status message; can be null/undefined if you want to reset it
   * @param {string} [to] The display name or the id of the friend; can be undefined if you want to update the presence status for all friends
   * @returns {Promise<void>}
   */
  setStatus(status, to) {
    let id;
    if (to) {
      const cachedFriend = this.friends.find((f) => f.id === to || f.displayName === to);
      if (!cachedFriend) throw new Error(`Failed sending a status to ${to}: Friend not existing`);
      id = this.Xmpp.sendStatus(status, `${cachedFriend.id}@${Endpoints.EPIC_PROD_ENV}`);
    } else {
      this.config.status = status;
      id = this.Xmpp.sendStatus(status);
    }

    return new Promise((res, rej) => {
      this.Xmpp.stream.on(`presence#${id}:sent`, () => res());
      setTimeout(() => rej(new Error('Failed sending a status: Status timeout of 20000ms exceeded')), 20000);
    });
  }

  // -------------------------------------FRIENDS-------------------------------------

  /**
   * Sends / accepts a friend request to an Epic Games user
   * @param {string} user The id, name or email of the user
   * @returns {Promise<void>}
   */
  async addFriend(user) {
    let userId;
    if (user.length === 32 && !user.includes('@')) userId = user;
    else {
      const lookedUpUser = await this.getProfile(user);
      if (!lookedUpUser) throw new Error(`Adding ${user} as a friend failed: Account not found`);
      userId = lookedUpUser.id;
    }
    const userRequest = await this.Http.send(true, 'POST', `${Endpoints.FRIEND_ADD}/${this.user.id}/${userId}`, `bearer ${this.Auth.auths.token}`);
    if (!userRequest.success) throw new Error(`Adding ${userId} as a friend failed: ${this.parseError(userRequest.response)}`);
  }

  /**
   * Removes a friend or reject an user's friend request
   * @param {string} user The id, name or email of the user
   * @returns {Promise<void>}
   */
  async removeFriend(user) {
    let userId;
    if (user.length === 32 && !user.includes('@')) userId = user;
    else {
      const lookedUpUser = await this.getProfile(user);
      if (!lookedUpUser) throw new Error(`Removing ${user} as a friend failed: Account not found`);
      userId = lookedUpUser.id;
    }
    const userRequest = await this.Http.send(true, 'DELETE', `${Endpoints.FRIEND_DELETE}/${this.user.id}/friends/${userId}`, `bearer ${this.Auth.auths.token}`);
    if (!userRequest.success) throw new Error(`Removing ${user} as a friend failed: ${this.parseError(userRequest.response)}`);
  }

  /**
   * Blocks a friend
   * @param {string} friend The id, name or email of the friend
   * @returns {Promise<void>}
   */
  async blockFriend(friend) {
    const cachedFriend = this.friends.find((f) => f.id === friend || f.displayName === friend);
    if (!cachedFriend) throw new Error(`Blocking ${friend} failed: Friend not existing`);

    const blockListUpdate = await this.Http.send(true, 'POST', `${Endpoints.FRIEND_BLOCK}/${this.user.id}/${cachedFriend.id}`, `bearer ${this.Auth.auths.token}`);
    if (!blockListUpdate.success) throw new Error(`Blocking ${friend} failed: ${this.parseError(blockListUpdate.response)}`);
  }

  /**
   * Unblocks a friend
   * @param {string} friend The id, name or email of the friend
   * @returns {Promise<void>}
   */
  async unblockFriend(friend) {
    const cachedBlockedFriend = this.blockedFriends.find((f) => f.id === friend || f.displayName === friend);
    if (!cachedBlockedFriend) throw new Error(`Unblocking ${friend} failed: User not in the blocklist`);

    const blockListUpdate = await this.Http.send(true, 'DELETE', `${Endpoints.FRIEND_BLOCK}/${this.user.id}/${cachedBlockedFriend.id}`, `bearer ${this.Auth.auths.token}`);
    if (!blockListUpdate.success) throw new Error(`Unblocking ${friend} failed: ${this.parseError(blockListUpdate.response)}`);
  }

  /**
   * Sends a message to a friend
   * @param {string} friend The id or name of the friend
   * @param {string} message The message
   * @returns {Promise<FriendMessage>} The sent friend message
   */
  async sendFriendMessage(friend, message) {
    if (!message) throw new Error(`Failed sending a friend message to ${friend}: Cannot send an empty message`);
    const cachedFriend = this.friends.find((f) => f.id === friend || f.displayName === friend);
    if (!cachedFriend) throw new Error(`Failed sending a friend message to ${friend}: Friend not existing`);
    const id = this.Xmpp.stream.sendMessage({
      to: `${cachedFriend.id}@${Endpoints.EPIC_PROD_ENV}`,
      type: 'chat',
      body: message,
    });

    return new Promise((res, rej) => {
      this.Xmpp.stream.once(`message#${id}:sent`, () => res(new FriendMessage(this, { body: message, author: this.user })));
      setTimeout(() => rej(new Error(`Failed sending a friend message to ${friend}: Message timeout of 20000ms exceeded`)), 20000);
    });
  }

  /**
   * Sends a party invitation to a friend
   * @param {string} friend The id or name of the friend
   * @returns {Promise<SentPartyInvitation>}
   */
  async invite(friend) {
    const cachedFriend = this.friends.find((f) => f.id === friend || f.displayName === friend);
    if (!cachedFriend) throw new Error(`Failed sending party invitation to ${friend}: Friend not existing`);
    if (this.party.members.get(cachedFriend.id)) throw new Error(`Failed sending party invitation to ${friend}: Friend is already in the party`);
    if (this.party.members.size === this.party.config.maxSize) throw new Error(`Failed sending party invitation to ${friend}: Party is full`);
    const data = await this.Http.send(true, 'POST',
      `${Endpoints.BR_PARTY}/parties/${this.party.id}/invites/${cachedFriend.id}?sendPing=true`, `bearer ${this.Auth.auths.token}`, null, {
        'urn:epic:cfg:build-id_s': '1:1:',
        'urn:epic:conn:platform_s': this.config.platform,
        'urn:epic:conn:type_s': 'game',
        'urn:epic:invite:platformdata_s': '',
        'urn:epic:member:dn_s': this.user.displayName,
      });
    if (!data.success) throw new Error(`Failed sending party invitation to ${friend}: ${this.parseError(data.response)}`);
    return new SentPartyInvitation(this, this.party, cachedFriend, {
      sent_at: Date.now(),
    });
  }

  // -------------------------------------BATTLE ROYALE-------------------------------------

  /**
   * Fetches news for a gamemode
   * @param {Gamemode} mode The gamemode
   * @param {Language} language The language
   * @returns {Promise<Array>}
   */
  async getNews(mode = Enums.Gamemode.BATTLE_ROYALE, language = Enums.Language.ENGLISH) {
    if (!Object.values(Enums.Gamemode).includes(mode)) throw new Error(`Fetching news failed: ${mode} is not a valid gamemode! Use the enum`);
    const news = await this.Http.send(false, 'GET', `${Endpoints.BR_NEWS}?lang=${language}`);
    if (!news.success) throw new Error(`Fetching news failed: ${this.parseError(news.response)}`);

    if (mode === Enums.Gamemode.BATTLE_ROYALE) return news.response[`${mode}news`].news.motds;
    return news.response[`${mode}news`].news.messages;
  }

  /**
   * Fetches v2 stats for one or multiple players
   * @param {string} user The id, name or email of the user(s)
   * @param {number} [startTime] The timestamp to start fetching stats from; can be null/undefined for lifetime
   * @param {number} [endTime] The timestamp to stop fetching stats from; can be undefined for lifetime
   * @returns {Promise<Object>}
   */
  async getBRStats(user, startTime, endTime) {
    let userId;
    if (user.length === 32 && !user.includes('@')) userId = user;
    else {
      const lookedUpUser = await this.getProfile(user);
      if (!lookedUpUser) throw new Error(`Fetching ${user}'s stats failed: Account not found`);
      userId = lookedUpUser.id;
    }

    const params = [];
    if (startTime) params.push(`startTime=${startTime}`);
    if (endTime) params.push(`startTime=${endTime}`);

    const stats = await this.Http.send(true, 'GET', `${Endpoints.BR_STATS_V2}/account/${userId}${params[0] ? `?${params.join('&')}` : ''}`, `bearer ${this.Auth.auths.token}`);
    if (!stats.success) throw new Error(`Fetching ${user}'s stats failed: ${this.parseError(stats.response)}`);

    return stats.response;
  }

  /**
   * Lookups for a creator code
   * @param {string} code The creator code
   * @param {boolean} showSimilar Whether an array with similar creator codes should be returned
   * @returns {Promise<CreatorCode>|Promise<Array<CreatorCode>>}
   */
  async getCreatorCode(code, showSimilar = false) {
    const codeRes = await this.Http.send(false, 'GET', `${Endpoints.BR_SAC_SEARCH}?slug=${code}`);
    if (!codeRes.success) throw new Error(`Fetching the creator code ${code} failed: ${this.parseError(codeRes.response)}`);

    const codes = codeRes.response.filter((c) => showSimilar ? c : c.slug === code);
    const parsedCodes = [];

    for (const ccode of codes) {
      const owner = await this.getProfile(ccode.id);
      parsedCodes.push(new CreatorCode(this, { ...ccode, owner }));
    }

    return showSimilar ? parsedCodes : parsedCodes[0];
  }

  /**
   * Fetches the current Battle Royale store
   * @param {Language} language The language
   * @returns {Promise<Object>} The Battle Royale store
   */
  async getBRStore(language = Enums.Language.ENGLISH) {
    const shop = await this.Http.send(true, 'GET', `${Endpoints.BR_STORE}?lang=${language}`, `bearer ${this.Auth.auths.token}`);
    if (!shop.success) throw new Error(`Fetching shop failed: ${this.parseError(shop.response)}`);

    return shop.response;
  }

  /**
   * Fetch the current Battle Royale event flags
   * @param {Language} language The language
   * @returns {Promise<Object>} The Battle Royale event flags
   */
  async getBREventFlags(language = Enums.Language.ENGLISH) {
    const eventFlags = await this.Http.send(true, 'GET', `${Endpoints.BR_EVENT_FLAGS}?lang=${language}`, `bearer ${this.Auth.auths.token}`);
    if (!eventFlags.success) throw new Error(`Fetching challenges failed: ${this.parseError(eventFlags.response)}`);

    return eventFlags.response;
  }
}

module.exports = Client;

/**
 * Emitted when the Client is ready
 * @event Client#ready
 */

/**
 * Emitted when a device auth is created for the client's user
 * @event Client#deviceauth:created
 * @param {DeviceAuthCredentials} credentials The device auth's credentials
 */

/**
 * Emitted when a member sends a message in the party's chat room
 * @event Client#party:member:message
 * @param {PartyMessage} partyMessage The party message
 */

/**
 * Emitted when a friend updates his presence
 * @event Client#friend:presence
 * @param {FriendPresence} friendPresence The friend's presence
 */

/**
 * Emitted when the client receives a message from a friend
 * @event Client#friend:message
 * @param {FriendMessage} friendMessage The friend message
 */

/**
 * Emitted when a friend request is accepted
 * @event Client#friend:added
 * @param {Friend} friend The added friend
 */

/**
 * Emitted when the client receives a friend request
 * @event Client#friend:request
 * @param {PendingFriend} pendingFriend The received friend request
 */

/**
 * Emitted when the client sends a friend request
 * @event Client#friend:request:sent
 * @param {PendingFriend} pendingFriend The sent friend request
 */

/**
 * Emitted when a friend request is aborted
 * @event Client#friend:request:aborted
 * @param {PendingFriend} pendingFriend The aborted friend request
 */

/**
 * Emitted when a friend request is rejected
 * @event Client#friend:request:rejected
 * @param {PendingFriend} pendingFriend The rejected friend request
 */

/**
 * Emitted when a friend is removed
 * @event Client#friend:removed
 * @param {Friend} friend The removed friend
 */

/**
 * Emitted when a friend is blocked
 * @event Client#friend:blocked
 * @param {Friend} friend The blocked friend
 */

/**
 * Emitted when a friend is unblocked
 * @event Client#friend:unblocked
 * @param {Friend} friend The unblocked friend
 */

/**
 * Emitted when the client receives a party invite
 * @event Client#party:invite
 * @param {PartyInvitation} partyInvitation The party invite
 */

/**
 * Emitted when a member joins the party
 * @event Client#party:member:joined
 * @param {PartyMember} partyMember The member that joined the party
 */

/**
 * Emitted when a party member gets updated
 * @event Client#party:member:updated
 * @param {PartyMember} partyMember The updated party member
 */

/**
 * Emitted when a member leaves the party
 * @event Client#party:member:left
 * @param {PartyMember} partyMember The party member
 */

/**
 * Emitted when a party member expires
 * @event Client#party:member:expired
 * @param {PartyMember} partyMember The party member
 */

/**
 * Emitted when a party member gets kicked
 * @event Client#party:member:kicked
 * @param {PartyMember} partyMember The kicked party member
 */

/**
 * Emitted when a party member gets disconnected
 * @event Client#party:member:disconnected
 * @param {PartyMember} partyMember The disconnected party member
 */

/**
 *  Emitted when a party member gets promoted
 * @event Client#party:member:promoted
 * @param {PartyMember} partyMember The promoted party member
 */

/**
 * Emitted when a party member gets updated
 * @event Client#party:updated
 * @param {PartyMember} partyMember The updated party member
 */

/**
 * Emitted when a party invite gets declined
 * @event Client#party:invite:declined
 * @param {Friend} friend The friend that declined the party invite
 */

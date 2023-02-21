import Bookmark from "discourse/models/bookmark";
import { openBookmarkModal } from "discourse/controllers/bookmark";
import { REACTIONS } from "discourse/plugins/chat/discourse/models/chat-message";
import { isTesting } from "discourse-common/config/environment";
import Component from "@glimmer/component";
import I18n from "I18n";
import optionalService from "discourse/lib/optional-service";
import { bind } from "discourse-common/utils/decorators";
import EmberObject, { action } from "@ember/object";
import { ajax } from "discourse/lib/ajax";
import { cancel, schedule } from "@ember/runloop";
import { inject as service } from "@ember/service";
import { popupAjaxError } from "discourse/lib/ajax-error";
import discourseLater from "discourse-common/lib/later";
import isZoomed from "discourse/plugins/chat/discourse/lib/zoom-check";
import showModal from "discourse/lib/show-modal";
import ChatMessageFlag from "discourse/plugins/chat/discourse/lib/chat-message-flag";
import { tracked } from "@glimmer/tracking";
import { getOwner } from "discourse-common/lib/get-owner";

let _chatMessageDecorators = [];

export function addChatMessageDecorator(decorator) {
  _chatMessageDecorators.push(decorator);
}

export function resetChatMessageDecorators() {
  _chatMessageDecorators = [];
}

export const MENTION_KEYWORDS = ["here", "all"];

export default class ChatMessage extends Component {
  @service site;
  @service dialog;
  @service currentUser;
  @service appEvents;
  @service chat;
  @service chatEmojiReactionStore;
  @service chatEmojiPickerManager;
  @service chatChannelsManager;
  @service router;

  @tracked chatMessageActionsMobileAnchor = null;
  @tracked chatMessageActionsDesktopAnchor = null;

  @optionalService adminTools;

  cachedFavoritesReactions = null;

  _hasSubscribedToAppEvents = false;
  _loadingReactions = [];

  constructor() {
    super(...arguments);

    this.args.message.id
      ? this._subscribeToAppEvents()
      : this._waitForIdToBePopulated();

    if (this.args.message.bookmark) {
      this.args.message.set(
        "bookmark",
        Bookmark.create(this.args.message.bookmark)
      );
    }

    this.cachedFavoritesReactions = this.chatEmojiReactionStore.favorites;
  }

  get deletedAndCollapsed() {
    return this.args.message?.get("deleted_at") && this.collapsed;
  }

  get hiddenAndCollapsed() {
    return this.args.message?.get("hidden") && this.collapsed;
  }

  get collapsed() {
    return !this.args.message?.get("expanded");
  }

  @action
  setMessageActionsAnchors() {
    schedule("afterRender", () => {
      this.chatMessageActionsDesktopAnchor = document.querySelector(
        ".chat-message-actions-desktop-anchor"
      );
      this.chatMessageActionsMobileAnchor = document.querySelector(
        ".chat-message-actions-mobile-anchor"
      );
    });
  }

  @action
  teardownChatMessage() {
    if (this.args.message?.stagedId) {
      this.appEvents.off(
        `chat-message-staged-${this.args.message.stagedId}:id-populated`,
        this,
        "_subscribeToAppEvents"
      );
    }

    this.appEvents.off("chat:refresh-message", this, "_refreshedMessage");

    this.appEvents.off(
      `chat-message-${this.args.message.id}:reaction`,
      this,
      "_handleReactionMessage"
    );

    cancel(this._invitationSentTimer);
  }

  @bind
  _refreshedMessage(message) {
    if (message.id === this.args.message.id) {
      this.decorateCookedMessage();
    }
  }

  @action
  decorateCookedMessage() {
    schedule("afterRender", () => {
      if (!this.messageContainer) {
        return;
      }

      _chatMessageDecorators.forEach((decorator) => {
        decorator.call(this, this.messageContainer, this.args.chatChannel);
      });
    });
  }

  get messageContainer() {
    const id = this.args.message?.id || this.args.message?.stagedId;
    return (
      id && document.querySelector(`.chat-message-container[data-id='${id}']`)
    );
  }

  _subscribeToAppEvents() {
    if (!this.args.message.id || this._hasSubscribedToAppEvents) {
      return;
    }

    this.appEvents.on("chat:refresh-message", this, "_refreshedMessage");

    this.appEvents.on(
      `chat-message-${this.args.message.id}:reaction`,
      this,
      "_handleReactionMessage"
    );
    this._hasSubscribedToAppEvents = true;
  }

  _waitForIdToBePopulated() {
    this.appEvents.on(
      `chat-message-staged-${this.args.message.stagedId}:id-populated`,
      this,
      "_subscribeToAppEvents"
    );
  }

  get showActions() {
    return (
      this.args.canInteractWithChat &&
      !this.args.message?.get("staged") &&
      this.args.isHovered
    );
  }

  get secondaryButtons() {
    const buttons = [];

    buttons.push({
      id: "copyLinkToMessage",
      name: I18n.t("chat.copy_link"),
      icon: "link",
    });

    if (this.showEditButton) {
      buttons.push({
        id: "edit",
        name: I18n.t("chat.edit"),
        icon: "pencil-alt",
      });
    }

    if (!this.args.selectingMessages) {
      buttons.push({
        id: "selectMessage",
        name: I18n.t("chat.select"),
        icon: "tasks",
      });
    }

    if (this.canFlagMessage) {
      buttons.push({
        id: "flag",
        name: I18n.t("chat.flag"),
        icon: "flag",
      });
    }

    if (this.showDeleteButton) {
      buttons.push({
        id: "deleteMessage",
        name: I18n.t("chat.delete"),
        icon: "trash-alt",
      });
    }

    if (this.showRestoreButton) {
      buttons.push({
        id: "restore",
        name: I18n.t("chat.restore"),
        icon: "undo",
      });
    }

    if (this.showRebakeButton) {
      buttons.push({
        id: "rebakeMessage",
        name: I18n.t("chat.rebake_message"),
        icon: "sync-alt",
      });
    }

    if (this.hasThread) {
      buttons.push({
        id: "openThread",
        name: I18n.t("chat.threads.open"),
        icon: "puzzle-piece",
      });
    }

    return buttons;
  }

  get messageActions() {
    return {
      reply: this.reply,
      edit: this.edit,
      flag: this.flag,
      deleteMessage: this.deleteMessage,
      restore: this.restore,
      rebakeMessage: this.rebakeMessage,
      toggleBookmark: this.toggleBookmark,
      openThread: this.openThread,
      startReactionForMessageActions: this.startReactionForMessageActions,
    };
  }

  get messageCapabilities() {
    return {
      canReact: this.canReact,
      canReply: this.canReply,
      canBookmark: this.showBookmarkButton,
      hasThread: this.canReply && this.hasThread,
    };
  }

  get hasThread() {
    return (
      this.args.chatChannel?.get("threading_enabled") &&
      this.args.message?.get("thread_id")
    );
  }

  get show() {
    return (
      !this.args.message?.get("deleted_at") ||
      this.currentUser.id === this.args.message?.get("user.id") ||
      this.currentUser.staff ||
      this.args.details?.can_moderate
    );
  }

  @action
  handleTouchStart() {
    // if zoomed don't track long press
    if (isZoomed()) {
      return;
    }

    if (!this.args.isHovered) {
      // when testing this must be triggered immediately because there
      // is no concept of "long press" there, the Ember `tap` test helper
      // does send the touchstart/touchend events but immediately, see
      // https://github.com/emberjs/ember-test-helpers/blob/master/API.md#tap
      if (isTesting()) {
        this._handleLongPress();
      }

      this._isPressingHandler = discourseLater(this._handleLongPress, 500);
    }
  }

  @action
  handleTouchMove() {
    if (!this.args.isHovered) {
      cancel(this._isPressingHandler);
    }
  }

  @action
  handleTouchEnd() {
    cancel(this._isPressingHandler);
  }

  @action
  _handleLongPress() {
    if (isZoomed()) {
      // if zoomed don't handle long press
      return;
    }

    document.activeElement.blur();
    document.querySelector(".chat-composer-input")?.blur();

    this.args.onHoverMessage?.(this.args.message);
  }

  get hideUserInfo() {
    return (
      this.args.message?.get("hideUserInfo") &&
      !this.args.message?.get("chat_webhook_event")
    );
  }

  get showEditButton() {
    return (
      !this.args.message?.get("deleted_at") &&
      this.currentUser?.id === this.args.message?.get("user.id") &&
      this.args.chatChannel?.canModifyMessages?.(this.currentUser)
    );
  }
  get canFlagMessage() {
    return (
      this.currentUser?.id !== this.args.message?.get("user.id") &&
      this.args.message?.get("user_flag_status") === undefined &&
      this.args.details?.can_flag &&
      !this.args.message?.get("chat_webhook_event") &&
      !this.args.message?.get("deleted_at")
    );
  }

  get canManageDeletion() {
    return this.currentUser?.id === this.args.message.get("user.id")
      ? this.args.details?.can_delete_self
      : this.args.details?.can_delete_others;
  }

  get canReply() {
    return (
      !this.args.message?.get("deleted_at") &&
      this.args.chatChannel?.canModifyMessages?.(this.currentUser)
    );
  }

  get canReact() {
    return (
      !this.args.message?.get("deleted_at") &&
      this.args.chatChannel?.canModifyMessages?.(this.currentUser)
    );
  }

  get showDeleteButton() {
    return (
      this.canManageDeletion &&
      !this.args.message?.get("deleted_at") &&
      this.args.chatChannel?.canModifyMessages?.(this.currentUser)
    );
  }

  get showRestoreButton() {
    return (
      this.canManageDeletion &&
      this.args.message?.get("deleted_at") &&
      this.args.chatChannel?.canModifyMessages?.(this.currentUser)
    );
  }

  get showBookmarkButton() {
    return this.args.chatChannel?.canModifyMessages?.(this.currentUser);
  }

  get showRebakeButton() {
    return (
      this.currentUser?.staff &&
      this.args.chatChannel?.canModifyMessages?.(this.currentUser)
    );
  }

  get mentionWarning() {
    return this.args.message.get("mentionWarning");
  }

  get mentionedCannotSeeText() {
    return this._findTranslatedWarning(
      "chat.mention_warning.cannot_see",
      "chat.mention_warning.cannot_see_multiple",
      {
        username: this.mentionWarning?.cannot_see?.[0]?.username,
        count: this.mentionWarning?.cannot_see?.length,
      }
    );
  }

  get mentionedWithoutMembershipText() {
    return this._findTranslatedWarning(
      "chat.mention_warning.without_membership",
      "chat.mention_warning.without_membership_multiple",
      {
        username: this.mentionWarning?.without_membership?.[0]?.username,
        count: this.mentionWarning?.without_membership?.length,
      }
    );
  }

  get groupsWithDisabledMentions() {
    return this._findTranslatedWarning(
      "chat.mention_warning.group_mentions_disabled",
      "chat.mention_warning.group_mentions_disabled_multiple",
      {
        group_name: this.mentionWarning?.group_mentions_disabled?.[0],
        count: this.mentionWarning?.group_mentions_disabled?.length,
      }
    );
  }

  get groupsWithTooManyMembers() {
    return this._findTranslatedWarning(
      "chat.mention_warning.too_many_members",
      "chat.mention_warning.too_many_members_multiple",
      {
        group_name: this.mentionWarning.groups_with_too_many_members?.[0],
        count: this.mentionWarning.groups_with_too_many_members?.length,
      }
    );
  }

  _findTranslatedWarning(oneKey, multipleKey, args) {
    const translationKey = args.count === 1 ? oneKey : multipleKey;
    args.count--;
    return I18n.t(translationKey, args);
  }

  @action
  inviteMentioned() {
    const userIds = this.mentionWarning.without_membership.mapBy("id");

    ajax(`/chat/${this.args.message.chat_channel_id}/invite`, {
      method: "PUT",
      data: { user_ids: userIds, chat_message_id: this.args.message.id },
    }).then(() => {
      this.args.message.set("mentionWarning.invitationSent", true);
      this._invitationSentTimer = discourseLater(() => {
        this.args.message.set("mentionWarning", null);
      }, 3000);
    });

    return false;
  }

  @action
  dismissMentionWarning() {
    this.args.message.set("mentionWarning", null);
  }

  @action
  startReactionForMessageActions() {
    this.chatEmojiPickerManager.startFromMessageActions(
      this.args.message,
      this.selectReaction,
      { desktop: this.site.desktopView }
    );
  }

  @action
  startReactionForReactionList() {
    this.chatEmojiPickerManager.startFromMessageReactionList(
      this.args.message,
      this.selectReaction,
      { desktop: this.site.desktopView }
    );
  }

  deselectReaction(emoji) {
    if (!this.args.canInteractWithChat) {
      return;
    }

    this.args.messageActionsHandler.react(
      this.args.message,
      emoji,
      REACTIONS.remove
    );
  }

  @action
  selectReaction(emoji) {
    if (!this.args.canInteractWithChat) {
      return;
    }

    this.args.messageActionsHandler.react(
      this.args.message,
      emoji,
      REACTIONS.add
    );
  }

  @bind
  _handleReactionMessage(busData) {
    const loadingReactionIndex = this.args.message.loadingReactions.indexOf(
      busData.emoji
    );
    if (loadingReactionIndex > -1) {
      return this.args.message.loadingReactions.splice(loadingReactionIndex, 1);
    }

    this.args.message.updateReactionsList(
      busData.emoji,
      busData.action,
      busData.user,
      this.currentUser.id === busData.user.id
    );
    this.args.afterReactionAdded();
  }

  get capabilities() {
    return getOwner(this).lookup("capabilities:main");
  }

  // TODO(roman): For backwards-compatibility.
  //   Remove after the 3.0 release.
  _legacyFlag() {
    this.dialog.yesNoConfirm({
      message: I18n.t("chat.confirm_flag", {
        username: this.args.message.user?.username,
      }),
      didConfirm: () => {
        return ajax("/chat/flag", {
          method: "PUT",
          data: {
            chat_message_id: this.args.message.id,
            flag_type_id: 7, // notify_moderators
          },
        }).catch(popupAjaxError);
      },
    });
  }

  @action
  reply() {
    this.args.setReplyTo(this.args.message.id);
  }

  viewReplyOrThread() {
    if (this.hasThread) {
      this.router.transitionTo(
        "chat.channel.thread",
        this.args.message.thread_id
      );
    } else {
      this.args.replyMessageClicked(this.args.message.in_reply_to);
    }
  }

  @action
  edit() {
    this.args.editButtonClicked(this.args.message.id);
  }

  @action
  flag() {
    const targetFlagSupported =
      requirejs.entries["discourse/lib/flag-targets/flag"];

    if (targetFlagSupported) {
      const model = EmberObject.create(this.args.message);
      model.set("username", model.get("user.username"));
      model.set("user_id", model.get("user.id"));
      let controller = showModal("flag", { model });

      controller.setProperties({ flagTarget: new ChatMessageFlag() });
    } else {
      this._legacyFlag();
    }
  }

  @action
  expand() {
    this.args.message.set("expanded", true);
  }

  @action
  restore() {
    return ajax(
      `/chat/${this.args.message.chat_channel_id}/restore/${this.args.message.id}`,
      {
        type: "PUT",
      }
    ).catch(popupAjaxError);
  }

  @action
  openThread() {
    this.router.transitionTo(
      "chat.channel.thread",
      this.args.message.thread_id
    );
  }

  @action
  toggleBookmark() {
    return openBookmarkModal(
      this.args.message.bookmark ||
        Bookmark.createFor(
          this.currentUser,
          "ChatMessage",
          this.args.message.id
        ),
      {
        onAfterSave: (savedData) => {
          const bookmark = Bookmark.create(savedData);
          this.args.message.set("bookmark", bookmark);
          this.appEvents.trigger(
            "bookmarks:changed",
            savedData,
            bookmark.attachedTo()
          );
        },
        onAfterDelete: () => {
          this.args.message.set("bookmark", null);
        },
      }
    );
  }

  @action
  rebakeMessage() {
    return ajax(
      `/chat/${this.args.message.chat_channel_id}/${this.args.message.id}/rebake`,
      {
        type: "PUT",
      }
    ).catch(popupAjaxError);
  }

  @action
  deleteMessage() {
    return ajax(
      `/chat/${this.args.message.chat_channel_id}/${this.args.message.id}`,
      {
        type: "DELETE",
      }
    ).catch(popupAjaxError);
  }

  @action
  toggleChecked(event) {
    if (event.shiftKey) {
      this.args.messageActionsHandler.bulkSelectMessages(
        this.args.message,
        event.target.checked
      );
    }

    this.args.messageActionsHandler.selectMessage(
      this.args.message,
      event.target.checked
    );
  }

  get emojiReactions() {
    const favorites = this.cachedFavoritesReactions;

    // may be a {} if no defaults defined in some production builds
    if (!favorites || !favorites.slice) {
      return [];
    }

    const userReactions = Object.keys(this.args.message.reactions || {}).filter(
      (key) => {
        return this.args.message.reactions[key].reacted;
      }
    );

    return favorites.slice(0, 3).map((emoji) => {
      if (userReactions.includes(emoji)) {
        return { emoji, reacted: true };
      } else {
        return { emoji, reacted: false };
      }
    });
  }
}

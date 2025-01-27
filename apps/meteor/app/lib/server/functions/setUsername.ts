import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import type { IUser } from '@rocket.chat/core-typings';
import { Invites } from '@rocket.chat/models';
import { api } from '@rocket.chat/core-services';

import { settings } from '../../../settings/server';
import { Users } from '../../../models/server';
import { hasPermissionAsync } from '../../../authorization/server/functions/hasPermission';
import { RateLimiter } from '../lib';
import { addUserToRoom } from './addUserToRoom';
import { setUserAvatar } from '.';
import { checkUsernameAvailability } from './checkUsernameAvailability';
import { getAvatarSuggestionForUser } from './getAvatarSuggestionForUser';
import { SystemLogger } from '../../../../server/lib/logger/system';

export const _setUsername = async function (userId: string, u: string, fullUser: IUser): Promise<unknown> {
	const username = u.trim();
	if (!userId || !username) {
		return { succes: false, error: 'User ID and Username are required' };
	}
	let nameValidation;
	try {
		nameValidation = new RegExp(`^${settings.get('UTF8_User_Names_Validation')}$`);
	} catch (error) {
		nameValidation = new RegExp('^[0-9a-zA-Z-_.]+$');
	}
	if (!nameValidation.test(username)) {
		return { succes: false, error: 'Invalid Username' };
	}
	const user = fullUser || Users.findOneById(userId);
	// User already has desired username, return
	if (user.username === username) {
		return { succes: true, user };
	}
	const previousUsername = user.username;
	// Check username availability or if the user already owns a different casing of the name
	if (!previousUsername || !(username.toLowerCase() === previousUsername.toLowerCase())) {
		if (!(await checkUsernameAvailability(username))) {
			return { succes: false, error: 'Username not available' };
		}
	}
	// If first time setting username, send Enrollment Email
	try {
		if (!previousUsername && user.emails && user.emails.length > 0 && settings.get('Accounts_Enrollment_Email')) {
			Meteor.defer(() => {
				Accounts.sendEnrollmentEmail(user._id);
			});
		}
	} catch (e: any) {
		SystemLogger.error(e);
	}
	// Set new username*
	Users.setUsername(user._id, username);
	user.username = username;
	if (!previousUsername && settings.get('Accounts_SetDefaultAvatar') === true) {
		// eslint-disable-next-line @typescript-eslint/ban-types
		const avatarSuggestions = (await getAvatarSuggestionForUser(user)) as {};
		let gravatar;
		Object.keys(avatarSuggestions).some((service) => {
			const avatarData = avatarSuggestions[+service as keyof typeof avatarSuggestions];
			if (service !== 'gravatar') {
				// eslint-disable-next-line dot-notation
				setUserAvatar(user, avatarData['blob'], avatarData['contentType'], service);
				gravatar = null;
				return { succes: true };
			}
			gravatar = avatarData;
			return { succes: false, error: 'Unable to update user' };
		});
		if (gravatar != null) {
			// eslint-disable-next-line dot-notation
			setUserAvatar(user, gravatar['blob'], gravatar['contentType'], 'gravatar');
		}
	}

	// If it's the first username and the user has an invite Token, then join the invite room
	if (!previousUsername && user.inviteToken) {
		const inviteData = await Invites.findOneById(user.inviteToken);
		if (inviteData?.rid) {
			await addUserToRoom(inviteData.rid, user);
		}
	}

	void api.broadcast('user.nameChanged', {
		_id: user._id,
		name: user.name,
		username: user.username,
	});

	return { succes: true, user };
};

export const setUsername = RateLimiter.limitFunction(_setUsername, 1, 60000, {
	async 0() {
		const userId = Meteor.userId();
		return !userId || !(await hasPermissionAsync(userId, 'edit-other-user-info'));
	},
});

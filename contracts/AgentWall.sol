// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Agent Wall
/// @notice A public message wall where only holders of an Agent ID token can post.
/// @dev No owner, no admin, no payable functions, no funds held, no selfdestruct.
///      The Agent ID contract address is set once in the constructor (immutable)
///      and can never be changed. This contract is a pure social registry.
interface IAgentID {
    /// @notice Returns the number of Agent ID tokens owned by `account`.
    function balanceOf(address account) external view returns (uint256);
}

contract AgentWall {
    /// @notice The Agent ID (ERC-721) contract used to gate posting.
    IAgentID public immutable agentId;

    /// @notice Maximum message length in bytes (280 characters for ASCII text).
    uint256 public constant MAX_MESSAGE_LENGTH = 280;

    /// @notice Maximum number of ids `getTopMessages` will return in one call.
    uint256 public constant MAX_TOP_MESSAGES = 50;

    /// @notice A single wall message.
    struct Message {
        address signer; // Agent ID holder who posted the message
        string message; // Message text, max 280 bytes
        uint256 timestamp; // Block timestamp when signed
        uint256 likes; // Number of likes received
    }

    /// @notice All messages, in posting order. Index = message id.
    Message[] private messages;

    /// @notice messageId => liker => true if the address already liked that message.
    mapping(uint256 => mapping(address => bool)) private hasLiked;

    /// @notice Emitted when an Agent ID holder posts a message.
    /// @param id The id of the new message.
    /// @param signer The address that signed the message.
    /// @param message The message text.
    /// @param timestamp The block timestamp of the signature.
    event MessageSigned(uint256 indexed id, address indexed signer, string message, uint256 timestamp);

    /// @notice Emitted when an address likes a message.
    /// @param id The id of the liked message.
    /// @param liker The address that liked the message.
    event Liked(uint256 indexed id, address indexed liker);

    /// @notice Sets the Agent ID contract used to gate posting. Immutable, no admin.
    /// @param _agentId Address of the Agent ID ERC-721 contract.
    constructor(address _agentId) {
        require(_agentId != address(0), "Agent ID address is zero");
        agentId = IAgentID(_agentId);
    }

    /// @notice Post a message to the wall.
    /// @dev Only addresses holding at least one Agent ID token may sign.
    ///      One address may sign many messages; each message is stored with
    ///      its signer and timestamp.
    /// @param message The message text, max 280 bytes.
    /// @return id The id of the newly created message.
    function sign(string calldata message) external returns (uint256 id) {
        require(agentId.balanceOf(msg.sender) > 0, "Not an Agent ID holder");
        require(bytes(message).length <= MAX_MESSAGE_LENGTH, "Message too long");
        id = messages.length;
        messages.push(
            Message({signer: msg.sender, message: message, timestamp: block.timestamp, likes: 0})
        );
        emit MessageSigned(id, msg.sender, message, block.timestamp);
    }

    /// @notice Like a message. Each address may like a given message only once.
    /// @dev Only Agent ID holders may like, so every like is an interaction
    ///      from an Agent ID address. A second like from the same address on
    ///      the same message reverts.
    /// @param id The id of the message to like.
    function like(uint256 id) external {
        require(agentId.balanceOf(msg.sender) > 0, "Not an Agent ID holder");
        require(id < messages.length, "Message does not exist");
        require(!hasLiked[id][msg.sender], "Already liked");
        hasLiked[id][msg.sender] = true;
        messages[id].likes += 1;
        emit Liked(id, msg.sender);
    }

    /// @notice Returns the total number of messages posted so far.
    function getMessageCount() external view returns (uint256) {
        return messages.length;
    }

    /// @notice Returns the full data of one message.
    /// @param id The id of the message.
    /// @return signer The address that signed the message.
    /// @return message The message text.
    /// @return timestamp The block timestamp when the message was signed.
    /// @return likes The number of likes the message has received.
    function getMessage(
        uint256 id
    ) external view returns (address signer, string memory message, uint256 timestamp, uint256 likes) {
        require(id < messages.length, "Message does not exist");
        Message storage m = messages[id];
        return (m.signer, m.message, m.timestamp, m.likes);
    }

    /// @notice Returns the ids of the top `n` messages, ordered by likes descending.
    /// @dev Simple selection sort over ids in memory. This is a view function, so
    ///      the iteration costs no gas when called off-chain. `n` is capped at 50.
    /// @param n How many top messages to return (max 50).
    /// @return topIds Message ids sorted by likes descending (ties: lower id first).
    function getTopMessages(uint256 n) external view returns (uint256[] memory topIds) {
        uint256 count = messages.length;
        if (n > MAX_TOP_MESSAGES) {
            n = MAX_TOP_MESSAGES;
        }
        if (n > count) {
            n = count;
        }
        topIds = new uint256[](n);
        if (n == 0) {
            return topIds;
        }
        // Working copy of all ids, sorted in place by likes descending.
        uint256[] memory ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = i;
        }
        // Selection sort: for each position, pick the remaining id with the most likes.
        for (uint256 i = 0; i < n; i++) {
            uint256 best = i;
            for (uint256 j = i + 1; j < count; j++) {
                if (messages[ids[j]].likes > messages[ids[best]].likes) {
                    best = j;
                }
            }
            (ids[i], ids[best]) = (ids[best], ids[i]);
            topIds[i] = ids[i];
        }
    }
}

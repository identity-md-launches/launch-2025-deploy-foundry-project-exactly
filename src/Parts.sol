// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Identity Machine inventory
/// @notice Game items tied to their recipient. Only the machine can issue or consume them.
///         There are no transfers, approvals, token metadata or marketplace interfaces.
contract Parts {
    address public immutable machine;
    uint256 public totalSupply;
    mapping(uint256 => address) private owners;
    mapping(address => uint256) public balanceOf;

    error NotMachine();
    error UnknownPart();
    error AlreadyIssued();
    error BadRecipient();

    event Issued(uint256 indexed id, address indexed owner);
    event Consumed(uint256 indexed id, address indexed owner);

    constructor(address machine_) { machine = machine_; }

    function ownerOf(uint256 id) public view returns (address owner) {
        owner = owners[id];
        if (owner == address(0)) revert UnknownPart();
    }

    function mint(address to, uint256 id) external {
        if (msg.sender != machine) revert NotMachine();
        if (to == address(0)) revert BadRecipient();
        if (owners[id] != address(0)) revert AlreadyIssued();
        owners[id] = to;
        ++balanceOf[to];
        ++totalSupply;
        emit Issued(id, to);
    }

    function burn(uint256 id) external {
        if (msg.sender != machine) revert NotMachine();
        address owner = ownerOf(id);
        delete owners[id];
        --balanceOf[owner];
        --totalSupply;
        emit Consumed(id, owner);
    }
}

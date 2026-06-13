// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDataStreamsVerifier} from "../interfaces/external/IDataStreamsVerifier.sol";

/**
 * @title MockVerifierProxy
 * @notice Mock Chainlink Data Streams verifier proxy for testing
 * @dev Mirrors the real payload format: payload = abi.encode(reportContext, reportData, rs, ss, rawVs)
 *      where reportData = abi.encode(ReportV3). "Verification" just unwraps reportData.
 */
contract MockVerifierProxy is IDataStreamsVerifier {
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }

    mapping(bytes32 => int192) public prices;

    function setPrice(bytes32 feedId, int192 price) external {
        prices[feedId] = price;
    }

    /// @notice Build a fullReport payload for a feed using the stored price and fresh timestamps
    function buildPayload(bytes32 feedId) external view returns (bytes memory) {
        int192 price = prices[feedId];
        require(price != 0, "Price not set for feed");

        ReportV3 memory report = ReportV3({
            feedId: feedId,
            validFromTimestamp: uint32(block.timestamp),
            observationsTimestamp: uint32(block.timestamp),
            nativeFee: 0,
            linkFee: 0,
            expiresAt: uint32(block.timestamp + 365 days),
            price: price,
            bid: price,
            ask: price
        });

        bytes32[3] memory reportContext;
        return abi.encode(reportContext, abi.encode(report));
    }

    /// @inheritdoc IDataStreamsVerifier
    function verify(bytes calldata payload, bytes calldata) external payable returns (bytes memory) {
        (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
        require(reportData.length >= 32, "Invalid report data");
        return reportData;
    }

    /// @inheritdoc IDataStreamsVerifier
    function s_feeManager() external pure returns (address) {
        return address(0);
    }
}

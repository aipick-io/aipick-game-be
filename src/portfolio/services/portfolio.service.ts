import { groupBy } from 'lodash';
import { Cron } from '@nestjs/schedule';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectPortfolioOfferService, InjectPortfolioRepository } from '@portfolio/decorators';
import { PortfolioRepository } from '@portfolio/repositories';
import { PortfolioEntity, PortfolioOfferEntity } from '@portfolio/entities';
import { PortfolioOfferService } from '@portfolio/services';
import { InjectUserService, UserService } from '@app/user';
import { getCurrentDayInUtc } from '@common/utils';
import { InjectTransactionsManagerDecorator } from '@core/decorators';
import { TransactionsManager } from '@core/managers';

export interface ListPortfoliosParams {
  userId?: string;
  offerIds?: string[];
}

export interface CreatePortfolioParams {
  userId: string;
  selectedTokens: string[];
  offerId: string;
}

export interface PortfolioService {
  list(params: ListPortfoliosParams): Promise<PortfolioEntity[]>;
  listForUserAndOffers(userId: string, offerIds: string[]): Promise<PortfolioEntity[]>;
  create(params: CreatePortfolioParams): Promise<PortfolioEntity>;
}

@Injectable()
export class PortfolioServiceImpl implements PortfolioService {
  constructor(
    @InjectPortfolioRepository() private readonly portfolioRepository: PortfolioRepository,
    @InjectPortfolioOfferService() private readonly portfolioOfferService: PortfolioOfferService,
    @InjectUserService() private readonly userService: UserService,
    @InjectTransactionsManagerDecorator() private readonly transactionsManager: TransactionsManager,
  ) {}

  public list(params: ListPortfoliosParams) {
    return this.portfolioRepository.find({
      userId: params.userId,
      offerIds: params.offerIds,
    });
  }

  public listForUserAndOffers(userId: string, offerIds: string[]) {
    if (!offerIds.length) {
      throw new BadRequestException('At least one offer should be provided.');
    }

    return this.portfolioRepository.find({
      userId,
      offerIds,
    });
  }

  public async create(params: CreatePortfolioParams) {
    const offer = await this.portfolioOfferService.getById(params.offerId);

    if (!offer) {
      throw new BadRequestException('Provided offer is not found');
    }

    const user = await this.userService.getById(params.userId);

    if (!user) {
      throw new BadRequestException('Provided user is not found');
    }

    if (offer.getDay() !== getCurrentDayInUtc() + 1) {
      throw new BadRequestException('Provided offer is not available.');
    }

    this.validateSelectedTokens(params.selectedTokens, offer);

    const portfolioForProvidedOfferExists = await this.portfolioRepository.existsByUserIdAndOfferId(
      params.userId,
      params.offerId,
    );

    if (portfolioForProvidedOfferExists) {
      throw new BadRequestException('Portfolio for this day already submitted.');
    }

    return this.portfolioRepository.create({
      user: params.userId,
      selectedTokens: params.selectedTokens,
      offer: params.offerId,
      isAwarded: false,
    });
  }

  @Cron('*/30 * * * *')
  public async awardPortfolios() {
    const offers = await this.portfolioOfferService.listOffersWaitingForCompletion();

    const portfolios = await this.portfolioRepository.find({
      isAwarded: false,
      offerIds: offers.map((offer) => offer.getId()),
    });

    const groupedPortfolios = groupBy(portfolios, (portfolio) => {
      return portfolio.getOfferId();
    });

    for (const offer of offers) {
      try {
        const offerPriceChanges = offer.getPriceChanges();

        const portfolios = groupedPortfolios[offer.getId()] || [];

        for (const portfolio of portfolios) {
          const earnedPoints = portfolio.getSelectedTokens().reduce((points, selectedToken) => {
            const percentage = offerPriceChanges[selectedToken];

            if (typeof percentage !== 'number') {
              throw new Error('Percentage change not found for token.');
            }

            return points + percentage;
          }, 0);

          await this.transactionsManager.useTransaction(async () => {
            await this.portfolioRepository.updateOneById(portfolio.getId(), {
              isAwarded: true,
              earnedPoints,
            });

            await this.userService.update(portfolio.getUserId(), { addPoints: earnedPoints });
          });
        }

        await this.portfolioOfferService.markOfferCompleted(offer.getId());

        Logger.log(`Offer ${offer.getId()} completed, updated ${portfolios.length} portfolios.`);
      } catch (error) {
        Logger.error(`Failed to award portfolios for offer: ${offer.getId()}`, error);
      }
    }
  }

  private validateSelectedTokens(selectedTokens: string[], offer: PortfolioOfferEntity) {
    const tokenOffers = offer.getTokenOffers();

    if (selectedTokens.length !== tokenOffers.length) {
      throw new BadRequestException('Invalid number of selected tokens');
    }

    return selectedTokens.every((token, index) => {
      return tokenOffers[index].firstToken === token || tokenOffers[index].secondToken === token;
    });
  }
}
